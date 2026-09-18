import type { AgentResult, TokenUsage } from "./types.js";

export const EMPTY_RESPONSE_CONTINUATION_PROMPT =
  "You did not produce a final answer. Continue and provide your final summary now.";

export class EmptyAgentResponseError extends Error {
  readonly usage: TokenUsage;

  constructor(message: string, usage: TokenUsage) {
    super(message);
    this.name = "EmptyAgentResponseError";
    this.usage = usage;
  }
}

export function addTokenUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  const usage: TokenUsage = {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheCreationTokens: a.cacheCreationTokens + b.cacheCreationTokens,
  };
  if (a.estimated || b.estimated) {
    usage.estimated = true;
  }
  return usage;
}

export async function recoverEmptyResponseOnce<T extends AgentResult>(
  error: unknown,
  continueOnce: (empty: EmptyAgentResponseError) => Promise<T>,
): Promise<T> {
  if (!(error instanceof EmptyAgentResponseError)) {
    throw error;
  }
  const continuation = await continueOnce(error);
  return {
    ...continuation,
    usage: addTokenUsage(error.usage, continuation.usage),
  };
}
