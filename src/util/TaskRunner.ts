import fastq from 'fastq';
import { log } from './ScriptLogger.js';

/**
 * A group of tasks sharing a context (e.g., a system prompt for cache warmup).
 */
export interface TaskGroup<TTask> {
  key: string;
  tasks: TTask[];
  context: any;
}

export interface TaskRunnerOptions<TTask, TResult> {
  worker: (task: TTask, context?: any) => Promise<TResult>;
  parallelism?: number;
  warmupDelayMs?: number;
  maxResults?: number;
  getStatus?: (result: TResult) => string;
  rateLimiter?: { waitForCapacity(): Promise<void> };
  onResult?: (task: TTask, result: TResult) => void;
}

export interface TaskRunnerSummary<TResult> {
  results: TResult[];
  counts: Record<string, number>;
  totalProcessed: number;
}

// Overload: flat mode
export async function runTasks<TTask, TResult>(
  input: TTask[],
  options: TaskRunnerOptions<TTask, TResult>
): Promise<TaskRunnerSummary<TResult>>;

// Overload: grouped mode
export async function runTasks<TTask, TResult>(
  input: TaskGroup<TTask>[],
  options: TaskRunnerOptions<TTask, TResult>
): Promise<TaskRunnerSummary<TResult>>;

/**
 * Run tasks in parallel with optional warmup delay for system prompt caching.
 *
 * Flat mode: pass TTask[] — all tasks share one implicit group.
 * Grouped mode: pass TaskGroup<TTask>[] — each group gets its own warmup.
 */
export async function runTasks<TTask, TResult>(
  input: TTask[] | TaskGroup<TTask>[],
  options: TaskRunnerOptions<TTask, TResult>
): Promise<TaskRunnerSummary<TResult>> {
  const {
    worker,
    parallelism = 10,
    warmupDelayMs = 5_000,
    maxResults = Infinity,
    getStatus = () => 'success',
    onResult,
  } = options;

  const results: TResult[] = [];
  const counts: Record<string, number> = {};

  const recordResult = (task: TTask, result: TResult) => {
    results.push(result);
    const status = getStatus(result);
    counts[status] = (counts[status] || 0) + 1;
    onResult?.(task, result);
  };

  if (!isTaskGroupArray(input)) {
    // ===== FLAT MODE =====
    const tasks = input as TTask[];
    if (tasks.length === 0) {
      logSummary(counts, 0);
      return { results, counts, totalProcessed: 0 };
    }

    // Run first task alone for warmup
    if (options.rateLimiter) await options.rateLimiter.waitForCapacity();
    const firstResult = await worker(tasks[0], undefined);
    recordResult(tasks[0], firstResult);

    if (tasks.length > 1) {
      // Wait for cache warmup
      await delay(warmupDelayMs);

      // Process remaining tasks at full parallelism
      const remaining = tasks.slice(1);
      const queue = fastq.promise(
        async (task: TTask): Promise<void> => {
          if (results.length >= maxResults) return;
          if (options.rateLimiter) await options.rateLimiter.waitForCapacity();
          const result = await worker(task, undefined);
          recordResult(task, result);
        },
        parallelism
      );

      const promises = remaining.map(task => queue.push(task));
      await Promise.all(promises);
    }

    logSummary(counts, results.length);
    return { results, counts, totalProcessed: results.length };

  } else {
    // ===== GROUPED MODE =====
    const groups = input as TaskGroup<TTask>[];
    if (groups.length === 0) {
      logSummary(counts, 0);
      return { results, counts, totalProcessed: 0 };
    }

    const allQueues = groups.map(g => ({
      key: g.key,
      tasks: g.tasks,
      context: g.context,
      currentIndex: 0,
      isWarmedUp: false,
      warmupCompleteTime: undefined as number | undefined,
    }));

    let nextQueueIndex = 0;
    let pendingTimers = 0;

    type QueueObj = typeof allQueues[0];

    const activeQueues = new Set<QueueObj>();

    // We'll resolve this promise when everything is done
    let resolveCompletion: () => void;
    const completionPromise = new Promise<void>(resolve => { resolveCompletion = resolve; });

    const tryAddNextQueue = () => {
      if (nextQueueIndex < allQueues.length) {
        const nextQueue = allQueues[nextQueueIndex];
        nextQueueIndex++;
        activeQueues.add(nextQueue);
        log(`Adding cache key queue: "${nextQueue.key}" (${nextQueue.tasks.length} tasks)`);
        queue.push(nextQueue);
      }
    };

    const checkCompletion = () => {
      // Defer the check: queue.idle() is always false when called from
      // within a worker, so we need to check after the worker returns
      // and fastq has decremented its active count.
      if (pendingTimers === 0) {
        setTimeout(() => {
          if (queue.idle() && pendingTimers === 0) {
            resolveCompletion();
          }
        }, 0);
      }
    };

    const queue = fastq.promise(
      async (queueObj: QueueObj): Promise<void> => {
        // Check if this queue is exhausted
        if (queueObj.currentIndex >= queueObj.tasks.length) {
          activeQueues.delete(queueObj);
          tryAddNextQueue();
          checkCompletion();
          return;
        }

        // Check max results
        if (results.length >= maxResults) {
          checkCompletion();
          return;
        }

        // If this queue is in warmup cooldown, re-queue after delay
        if (queueObj.warmupCompleteTime !== undefined) {
          const now = Date.now();
          const timeRemaining = queueObj.warmupCompleteTime - now;

          if (timeRemaining > 0) {
            pendingTimers++;
            setTimeout(() => {
              pendingTimers--;
              queue.push(queueObj);
              checkCompletion();
            }, timeRemaining);
            tryAddNextQueue();
            checkCompletion();
            return;
          } else {
            queueObj.warmupCompleteTime = undefined;
          }
        }

        const task = queueObj.tasks[queueObj.currentIndex];
        queueObj.currentIndex++;

        const isFirstTask = !queueObj.isWarmedUp;
        if (isFirstTask) {
          queueObj.isWarmedUp = true;
          log(`Warming up cache for "${queueObj.key}" (${queueObj.tasks.length} tasks total)`);
        }

        if (options.rateLimiter) await options.rateLimiter.waitForCapacity();
        const result = await worker(task, queueObj.context);
        recordResult(task, result);

        if (isFirstTask) {
          log(`  Cache warmup complete for "${queueObj.key}", cooldown for ${warmupDelayMs}ms...`);
          queueObj.warmupCompleteTime = Date.now() + warmupDelayMs;
        }

        // Re-queue if more tasks remain
        if (queueObj.currentIndex < queueObj.tasks.length) {
          queue.push(queueObj);

          // Fill idle worker slots if this is one of the last active queues
          const remainingTasks = queueObj.tasks.length - queueObj.currentIndex;
          const numActiveQueues = activeQueues.size;
          if (numActiveQueues < parallelism && remainingTasks > parallelism) {
            const slotsToFill = parallelism - numActiveQueues;
            for (let i = 0; i < slotsToFill - 1; i++) {
              queue.push(queueObj);
            }
          }
        } else {
          activeQueues.delete(queueObj);
          tryAddNextQueue();
        }

        checkCompletion();
      },
      parallelism
    );

    // Seed with initial queues
    const initialCount = Math.min(parallelism, allQueues.length);
    nextQueueIndex = initialCount;

    for (let i = 0; i < initialCount; i++) {
      activeQueues.add(allQueues[i]);
      queue.push(allQueues[i]);
    }

    log(`Starting with ${initialCount} parallel cache key queues`);

    // Wait for all work to complete (queue idle AND no pending timers)
    await completionPromise;

    logSummary(counts, results.length);
    return { results, counts, totalProcessed: results.length };
  }
}

function isTaskGroupArray<TTask>(input: TTask[] | TaskGroup<TTask>[]): input is TaskGroup<TTask>[] {
  if (input.length === 0) return false;
  const first = input[0] as any;
  return first && typeof first === 'object' && 'key' in first && 'tasks' in first && 'context' in first;
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function logSummary(counts: Record<string, number>, total: number): void {
  const parts = Object.entries(counts).map(([status, count]) => `${count} ${status}`);
  log(`TaskRunner complete: ${parts.join(', ')} (${total} total)`);
}
