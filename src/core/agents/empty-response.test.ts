import { describe, expect, it, vi } from "vitest";
import {
  EmptyAgentResponseError,
  addTokenUsage,
  recoverEmptyResponseOnce,
} from "./empty-response.js";
import type { TokenUsage } from "./types.js";

const firstUsage: TokenUsage = {
  inputTokens: 2,
  outputTokens: 1,
  cacheReadTokens: 3,
  cacheCreationTokens: 4,
};

const secondUsage: TokenUsage = {
  inputTokens: 5,
  outputTokens: 6,
  cacheReadTokens: 7,
  cacheCreationTokens: 8,
};

function result(summary: string, usage: TokenUsage) {
  return {
    output: {
      success: true,
      summary,
      key_changes_made: [],
      key_learnings: [],
    },
    usage,
  };
}

describe("recoverEmptyResponseOnce", () => {
  it("continues once and treats a valid retry as success", async () => {
    const continueOnce = vi.fn(async () => result("recovered", secondUsage));

    const recovered = await recoverEmptyResponseOnce(
      new EmptyAgentResponseError(
        "OpenCode produced no final answer",
        firstUsage,
      ),
      continueOnce,
    );

    expect(continueOnce).toHaveBeenCalledTimes(1);
    expect(recovered.output.summary).toBe("recovered");
    expect(recovered.usage).toEqual({
      inputTokens: 7,
      outputTokens: 7,
      cacheReadTokens: 10,
      cacheCreationTokens: 12,
    });
  });

  it("records the original failure when the retry is still empty", async () => {
    const continueOnce = vi.fn(async () => {
      throw new EmptyAgentResponseError(
        "OpenCode produced no final answer",
        secondUsage,
      );
    });

    await expect(
      recoverEmptyResponseOnce(
        new EmptyAgentResponseError(
          "OpenCode produced no final answer",
          firstUsage,
        ),
        continueOnce,
      ),
    ).rejects.toThrow("OpenCode produced no final answer");
    expect(continueOnce).toHaveBeenCalledTimes(1);
  });

  it("does not continue real provider errors", async () => {
    const continueOnce = vi.fn();

    await expect(
      recoverEmptyResponseOnce(
        new Error("OpenCode provider overloaded: boom"),
        continueOnce,
      ),
    ).rejects.toThrow("OpenCode provider overloaded: boom");
    expect(continueOnce).not.toHaveBeenCalled();
  });

  it("aborts the continuation instead of recording a failure", async () => {
    const continueOnce = vi.fn(async () => {
      throw new Error("Agent was aborted");
    });

    await expect(
      recoverEmptyResponseOnce(
        new EmptyAgentResponseError(
          "OpenCode produced no final answer",
          firstUsage,
        ),
        continueOnce,
      ),
    ).rejects.toThrow("Agent was aborted");
    expect(continueOnce).toHaveBeenCalledTimes(1);
  });
});

describe("addTokenUsage", () => {
  it("preserves estimated when either turn was estimated", () => {
    expect(
      addTokenUsage({ ...firstUsage, estimated: true }, secondUsage).estimated,
    ).toBe(true);
    expect(addTokenUsage(firstUsage, secondUsage).estimated).toBeUndefined();
  });
});
