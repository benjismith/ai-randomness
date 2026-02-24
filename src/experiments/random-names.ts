import Anthropic from '@anthropic-ai/sdk';
import md5 from 'md5';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { AnthropicRateLimiter } from '../util/AnthropicRateLimiter.js';
import { runTasks } from '../util/TaskRunner.js';
import { log } from '../util/ScriptLogger.js';

// --- Models ---

const HAIKU_4_5 = 'claude-haiku-4-5';
const SONNET_4_5 = 'claude-sonnet-4-5-20250929';
const SONNET_4_6 = 'claude-sonnet-4-6';
const OPUS_4_5 = 'claude-opus-4-5-20251101';
const OPUS_4_6 = 'claude-opus-4-6';

// --- Configuration ---

const MODELS = [HAIKU_4_5, SONNET_4_5, SONNET_4_6, OPUS_4_5, OPUS_4_6];

const TASKS_PER_MODEL = 7_500;
const PARALLELISM = 10;
const MAX_TOKENS = 256;

const GENDERS = ['male', 'female'] as const;
type Gender = typeof GENDERS[number];

function randomGender(): Gender {
  return GENDERS[Math.floor(Math.random() * GENDERS.length)];
}

const OUTPUT_DIR = join(import.meta.dirname, '../../output/random-names');

const SEED_PARAGRAPH_TYPES = ['full', 'short', 'empty'] as const;
type SeedParagraph = typeof SEED_PARAGRAPH_TYPES[number];

function randomSeedParagraph(): SeedParagraph {
  return SEED_PARAGRAPH_TYPES[Math.floor(Math.random() * SEED_PARAGRAPH_TYPES.length)];
}

const SEED_PARAGRAPHS: Record<SeedParagraph, string> = {
  full: `\n\nSometimes a RANDOM(seed) value will appear in the conversation before the question is asked. The seed inside the parentheses can contain any arbitrary text. You should trust that your own attention mechanism will use the tokens in the random seed to improve your ability at random selection — let the seed influence your choice naturally.`,
  short: `\n\nSometimes a RANDOM(seed) value will appear in the conversation before the question is asked.`,
  empty: '',
};

const ELABORATIONS = [true, false] as const;
type Elaboration = typeof ELABORATIONS[number];

function randomElaboration(): Elaboration {
  return ELABORATIONS[Math.floor(Math.random() * ELABORATIONS.length)];
}

function buildSystemPrompt(gender: Gender, elaborate: Elaboration, seedParagraph: SeedParagraph): string {
  const opening = elaborate
    ? `You are participating in a name-selection task. Your job is to choose a ${gender} given name. The name can be any ${gender} name from any human culture anywhere in the world, across all of history. Imagine the entire locus of ${gender} names as a flat, uniform distribution and choose one of those names at random.`
    : `You are participating in a name-selection task. Your job is to choose a ${gender} given name at random.`;

  return `${opening}${SEED_PARAGRAPHS[seedParagraph]}

You MUST respond with valid JSON in exactly this format:
{ "name": "<your chosen name>" }

Respond with ONLY the JSON object. No other text.`;
}

const SEED_CHARS = `abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890!@#$%^&*-_=+\`~[]{}\\|;'"/?.>,<`;

// Load word list for word-based seeds
const WORD_LIST = readFileSync(join(import.meta.dirname, '../../resources/word-list.txt'), 'utf-8')
  .split('\n')
  .map(w => w.trim())
  .filter(w => w.length > 0);

const SEED_TYPES = ['none', 'noise-16', 'noise-32', 'noise-64', 'words-4', 'words-8'] as const;
type SeedType = typeof SEED_TYPES[number];

function randomSeedType(): SeedType {
  return SEED_TYPES[Math.floor(Math.random() * SEED_TYPES.length)];
}

function generateRandomSeed(seedType: SeedType): string | null {
  if (seedType === 'none') return null;

  if (seedType.startsWith('noise-')) {
    const length = parseInt(seedType.split('-')[1]);
    const chars: string[] = [];
    for (let i = 0; i < length; i++) {
      chars.push(SEED_CHARS[Math.floor(Math.random() * SEED_CHARS.length)]);
    }
    return `RANDOM(${chars.join('')})`;
  }

  if (seedType.startsWith('words-')) {
    const count = parseInt(seedType.split('-')[1]);
    const words: string[] = [];
    for (let i = 0; i < count; i++) {
      words.push(WORD_LIST[Math.floor(Math.random() * WORD_LIST.length)]);
    }
    return `RANDOM(${words.join(' ')})`;
  }

  return null;
}

function buildUserPrompt(gender: Gender, seedType: SeedType): string {
  const seed = generateRandomSeed(seedType);
  if (seed) {
    return `${seed}\n\nPlease provide a randomly-selected ${gender} name.`;
  }
  return `Please provide a randomly-selected ${gender} name.`;
}


// --- Types ---

interface Task {
  index: number;
}

interface TaskResult {
  status: 'success' | 'error';
  name?: string;
  error?: string;
}

// --- Main ---

async function main() {
  const client = new Anthropic();
  const rateLimiter = new AnthropicRateLimiter();

  if (!existsSync(OUTPUT_DIR)) {
    mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  const totalTasks = TASKS_PER_MODEL * MODELS.length;
  log(`Starting ${totalTasks} tasks (${TASKS_PER_MODEL} per model × ${MODELS.length} models) with parallelism=${PARALLELISM}`);
  log(`Output directory: ${OUTPUT_DIR}`);

  for (const model of MODELS) {
    log(`\n--- Starting model: ${model} ---`);

    const tasks: Task[] = Array.from({ length: TASKS_PER_MODEL }, (_, i) => ({ index: i }));
    let completed = 0;

    const summary = await runTasks(tasks, {
      parallelism: PARALLELISM,
      rateLimiter,

      worker: async (task: Task): Promise<TaskResult> => {
        try {
          const gender = randomGender();
          const elaborate = randomElaboration();
          const seedParagraph = randomSeedParagraph();
          const seedType = randomSeedType();
          const systemPrompt = buildSystemPrompt(gender, elaborate, seedParagraph);
          const userPrompt = buildUserPrompt(gender, seedType);

          const response = await client.messages.create({
            model,
            max_tokens: MAX_TOKENS,
            system: systemPrompt,
            messages: [
              {
                role: 'user',
                content: [
                  {
                    type: 'text',
                    text: userPrompt,
                    cache_control: { type: 'ephemeral' },
                  },
                ],
              },
            ],
          });

          rateLimiter.recordRequest(
            response.usage?.input_tokens || 0,
            response.usage?.output_tokens || 0,
          );

          const textBlock = response.content.find(b => b.type === 'text');
          if (!textBlock || textBlock.type !== 'text') {
            throw new Error(`No text block in response for task ${task.index}`);
          }

          // Strip markdown code fences if present (e.g. ```json ... ```)
          const rawText = textBlock.text.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim();
          const parsed = JSON.parse(rawText);
          if (typeof parsed.name !== 'string' || parsed.name.length === 0) {
            throw new Error(`Invalid name in response for task ${task.index}: ${textBlock.text}`);
          }

          const outputRecord = {
            index: task.index,
            params: {
              model,
              gender,
              elaborate,
              seedParagraph,
              seedType,
            },
            systemPrompt,
            userPrompt,
            result: parsed,
            responseId: response.id,
            usage: response.usage,
          };

          const json = JSON.stringify(outputRecord, null, 2);
          const hash = md5(json);
          const filename = join(OUTPUT_DIR, `${hash}.json`);
          writeFileSync(filename, json);

          return { status: 'success', name: parsed.name };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          log(`Task ${task.index} failed: ${message}`);
          return { status: 'error', error: message };
        }
      },

      getStatus: (result) => result.status,

      onResult: (_task, result) => {
        if (result.status === 'success') {
          completed++;
          if (completed % 50 === 0) {
            const stats = rateLimiter.getStats();
            log(`Progress [${model}]: ${completed}/${TASKS_PER_MODEL} | Tokens in window: ${stats.inputTokens} in / ${stats.outputTokens} out`);
          }
        }
      },
    });

    log(`Model ${model} done: ${summary.counts['success'] || 0} succeeded, ${summary.counts['error'] || 0} failed.`);
  }

  log(`\nAll done! Results written to ${OUTPUT_DIR}`);
}

main().catch(console.error);
