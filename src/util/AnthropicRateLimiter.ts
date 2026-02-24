/**
 * Rate limiter for Anthropic API requests.
 * Enforces limits on requests per minute, input tokens per minute, and output tokens per minute.
 */
export class AnthropicRateLimiter {
  private requestTimestamps: number[] = [];
  private inputTokenRecords: { timestamp: number; tokens: number }[] = [];
  private outputTokenRecords: { timestamp: number; tokens: number }[] = [];

  private readonly maxRequestsPerMinute: number;
  private readonly maxInputTokensPerMinute: number;
  private readonly maxOutputTokensPerMinute: number;
  private readonly windowMs: number = 60_000; // 1 minute

  constructor(
    maxRequestsPerMinute: number = 1000,
    maxInputTokensPerMinute: number = 450_000,
    maxOutputTokensPerMinute: number = 90_000
  ) {
    this.maxRequestsPerMinute = maxRequestsPerMinute;
    this.maxInputTokensPerMinute = maxInputTokensPerMinute;
    this.maxOutputTokensPerMinute = maxOutputTokensPerMinute;
  }

  /**
   * Cleans up old records outside the sliding window.
   */
  private cleanup(now: number): void {
    const cutoff = now - this.windowMs;
    this.requestTimestamps = this.requestTimestamps.filter(ts => ts > cutoff);
    this.inputTokenRecords = this.inputTokenRecords.filter(r => r.timestamp > cutoff);
    this.outputTokenRecords = this.outputTokenRecords.filter(r => r.timestamp > cutoff);
  }

  /**
   * Gets the current usage within the sliding window.
   */
  private getUsage(now: number): { requests: number; inputTokens: number; outputTokens: number } {
    this.cleanup(now);
    return {
      requests: this.requestTimestamps.length,
      inputTokens: this.inputTokenRecords.reduce((sum, r) => sum + r.tokens, 0),
      outputTokens: this.outputTokenRecords.reduce((sum, r) => sum + r.tokens, 0),
    };
  }

  /**
   * Calculates how long to wait before making a request.
   * Returns 0 if no wait is needed.
   */
  private getWaitTime(now: number): number {
    this.cleanup(now);

    let waitTime = 0;

    // Check request limit
    if (this.requestTimestamps.length >= this.maxRequestsPerMinute) {
      const oldestRequest = this.requestTimestamps[0];
      const waitForRequests = oldestRequest + this.windowMs - now + 100; // +100ms buffer
      waitTime = Math.max(waitTime, waitForRequests);
    }

    // Check input token limit (use 90% threshold since we don't know exact input size ahead of time)
    const inputTokens = this.inputTokenRecords.reduce((sum, r) => sum + r.tokens, 0);
    if (inputTokens >= this.maxInputTokensPerMinute * 0.9) {
      const oldestInput = this.inputTokenRecords[0];
      if (oldestInput) {
        const waitForInput = oldestInput.timestamp + this.windowMs - now + 100;
        waitTime = Math.max(waitTime, waitForInput);
      }
    }

    // Check output token limit
    const outputTokens = this.outputTokenRecords.reduce((sum, r) => sum + r.tokens, 0);
    if (outputTokens >= this.maxOutputTokensPerMinute * 0.9) {
      const oldestOutput = this.outputTokenRecords[0];
      if (oldestOutput) {
        const waitForOutput = oldestOutput.timestamp + this.windowMs - now + 100;
        waitTime = Math.max(waitTime, waitForOutput);
      }
    }

    return Math.max(0, waitTime);
  }

  /**
   * Wait until it's safe to make a request.
   * Call this before each API request.
   */
  async waitForCapacity(): Promise<void> {
    const now = Date.now();
    const waitTime = this.getWaitTime(now);

    if (waitTime > 0) {
      const usage = this.getUsage(now);
      console.log(`Rate limit: waiting ${Math.ceil(waitTime / 1000)}s (requests: ${usage.requests}/${this.maxRequestsPerMinute}, input: ${usage.inputTokens}/${this.maxInputTokensPerMinute}, output: ${usage.outputTokens}/${this.maxOutputTokensPerMinute})`);
      await this.sleep(waitTime);
    }
  }

  /**
   * Record a completed request with its token usage.
   * Call this after each API request completes.
   */
  recordRequest(inputTokens: number, outputTokens: number): void {
    const now = Date.now();
    this.requestTimestamps.push(now);
    this.inputTokenRecords.push({ timestamp: now, tokens: inputTokens });
    this.outputTokenRecords.push({ timestamp: now, tokens: outputTokens });
  }

  /**
   * Get current usage stats for logging.
   */
  getStats(): { requests: number; inputTokens: number; outputTokens: number } {
    return this.getUsage(Date.now());
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// Shared singleton instance for use across scripts
let sharedInstance: AnthropicRateLimiter | null = null;

export function getSharedRateLimiter(): AnthropicRateLimiter {
  if (!sharedInstance) {
    sharedInstance = new AnthropicRateLimiter();
  }
  return sharedInstance;
}
