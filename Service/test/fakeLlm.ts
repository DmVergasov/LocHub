import type Anthropic from '@anthropic-ai/sdk';
import type { LlmClient, LlmOutcome, LlmRequest } from '../src/llm.js';

export interface FakeLlmClientOptions {
  // Overrides the default countInputTokens behavior (always resolves to 1000). Can reject — a script that
  // wants to prove the caller's rate-limit/hard-error handling throws from here, the same way the real SDK's
  // client.messages.countTokens would reject after its own retries are exhausted.
  countInputTokens?: (params: Anthropic.MessageCreateParamsNonStreaming) => Promise<number>;
}

// Scripted LLM for tests: the respond callback sees every request and returns its outcome.
export class FakeLlmClient implements LlmClient {
  readonly calls: LlmRequest[] = [];
  // Tracks countInputTokens invocations separately from runSync: a gate that must refuse a request before
  // any token counting (e.g. the ai_not_ready check) is only proven by this staying at 0.
  countInputTokensCalls = 0;
  // High-water mark of countInputTokens calls in flight at once, proving estimateJob's bounded concurrency
  // (estimate-speed-brief.md §1) actually overlaps calls instead of running them one at a time.
  maxConcurrentCountInputTokens = 0;
  private inFlightCountInputTokens = 0;

  constructor(
    private readonly respond: (request: LlmRequest) => LlmOutcome,
    private readonly options: FakeLlmClientOptions = {},
  ) {}

  async runSync(requests: LlmRequest[], _concurrency?: number, onOutcome?: (outcome: LlmOutcome) => void): Promise<LlmOutcome[]> {
    this.calls.push(...requests);
    return requests.map((r) => {
      const outcome = this.respond(r);
      onOutcome?.(outcome);
      return outcome;
    });
  }

  async runBatch(requests: LlmRequest[]): Promise<LlmOutcome[]> {
    return this.runSync(requests);
  }

  async countInputTokens(params: Anthropic.MessageCreateParamsNonStreaming): Promise<number> {
    this.countInputTokensCalls++;
    this.inFlightCountInputTokens++;
    this.maxConcurrentCountInputTokens = Math.max(this.maxConcurrentCountInputTokens, this.inFlightCountInputTokens);
    try {
      return this.options.countInputTokens ? await this.options.countInputTokens(params) : 1000;
    } finally {
      this.inFlightCountInputTokens--;
    }
  }
}

export function requestItems(request: LlmRequest): Record<string, unknown>[] {
  const content = request.params.messages[0]!.content as string;
  return (JSON.parse(content) as { items: Record<string, unknown>[] }).items;
}

export function isJudgeRequest(request: LlmRequest): boolean {
  return JSON.stringify(request.params.output_config).includes('"issues"');
}

export function ok(customId: string, value: unknown): LlmOutcome {
  return { customId, kind: 'ok', text: typeof value === 'string' ? value : JSON.stringify(value), inputTokens: 10, outputTokens: 5 };
}
