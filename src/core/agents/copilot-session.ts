import type { TokenUsage } from "./types.js";

const EMPTY_USAGE: TokenUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
};

export class CopilotEmptyTurnError extends Error {
  readonly sessionId: string | null;
  readonly usage: TokenUsage;

  constructor(sessionId: string | null, usage: TokenUsage = EMPTY_USAGE) {
    super("copilot returned no agent message");
    this.name = "CopilotEmptyTurnError";
    this.sessionId = sessionId;
    this.usage = usage;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Exact-session identifier from Copilot JSONL: `session.start` `data.sessionId`.
 * Recency `--continue` and the interactive `--resume` picker are not identifiers.
 */
export function extractCopilotSessionId(event: unknown): string | null {
  if (!isRecord(event) || event.type !== "session.start") {
    return null;
  }
  if (!isRecord(event.data) || typeof event.data.sessionId !== "string") {
    return null;
  }
  const sessionId = event.data.sessionId.trim();
  return sessionId.length > 0 ? sessionId : null;
}

export function copilotExactSessionArgs(sessionId: string): string[] {
  return ["--session-id", sessionId];
}
