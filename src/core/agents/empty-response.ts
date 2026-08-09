import { appendDebugLog } from "../debug-log.js";
import type { AgentResult, OnUsage, TokenUsage } from "./types.js";

export const EMPTY_RESPONSE_CONTINUATION_PROMPT =
  "You did not produce a final answer. Continue and provide your final summary now.";

/**
 * Thrown by an adapter when a turn produced no final message. `turnCompleted`
 * separates "the agent finished its turn and simply said nothing" - which one
 * continuation nudge can recover - from "the transport died before the turn
 * ended", where nudging would post into a session that is still working (or
 * gone) and would replace a clear diagnostic with a transport error.
 */
export class EmptyAgentResponseError extends Error {
  readonly turnCompleted: boolean;

  constructor(message: string, options: { turnCompleted: boolean }) {
    super(message);
    this.name = "EmptyAgentResponseError";
    this.turnCompleted = options.turnCompleted;
  }
}

export function emptyTokenUsage(): TokenUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
  };
}

export function addTokenUsage(left: TokenUsage, right: TokenUsage): TokenUsage {
  const total: TokenUsage = {
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    cacheReadTokens: left.cacheReadTokens + right.cacheReadTokens,
    cacheCreationTokens: left.cacheCreationTokens + right.cacheCreationTokens,
  };
  if (left.estimated || right.estimated) {
    total.estimated = true;
  }
  return total;
}

export interface EmptyResponseRetryOptions {
  /** Debug-log event name recorded when the nudge is sent. */
  logEvent: string;
  logFields?: Record<string, unknown>;
  onUsage?: OnUsage;
  /** Prompt for the first turn. The continuation turn is always the bare nudge. */
  initialText: string;
  runTurn: (text: string, onTurnUsage: OnUsage) => Promise<AgentResult>;
}

/**
 * Runs one turn and, if it completed without a final message, runs exactly one
 * bare continuation turn in the same session. Usage reported to `onUsage` stays
 * cumulative across both turns; any other failure propagates untouched.
 */
export async function runTurnWithEmptyResponseRetry({
  logEvent,
  logFields,
  onUsage,
  initialText,
  runTurn,
}: EmptyResponseRetryOptions): Promise<AgentResult> {
  let firstTurnUsage = emptyTokenUsage();

  try {
    return await runTurn(initialText, (usage) => {
      firstTurnUsage = { ...usage };
      onUsage?.(usage);
    });
  } catch (error) {
    if (!(error instanceof EmptyAgentResponseError) || !error.turnCompleted) {
      throw error;
    }

    appendDebugLog(logEvent, {
      ...logFields,
      attempt: 1,
      prompt: EMPTY_RESPONSE_CONTINUATION_PROMPT,
    });

    const retry = await runTurn(EMPTY_RESPONSE_CONTINUATION_PROMPT, (usage) => {
      onUsage?.(addTokenUsage(firstTurnUsage, usage));
    });

    return {
      output: retry.output,
      usage: addTokenUsage(firstTurnUsage, retry.usage),
    };
  }
}
