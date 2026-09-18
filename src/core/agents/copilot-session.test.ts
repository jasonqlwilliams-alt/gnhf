import { describe, expect, it } from "vitest";
import { EmptyAgentResponseError } from "./empty-response.js";
import {
  CopilotEmptyTurnError,
  copilotExactSessionArgs,
  extractCopilotSessionId,
} from "./copilot-session.js";

const SESSION_ID = "0cb916db-26aa-40f2-86b5-1ba81b225fd2";

describe("extractCopilotSessionId", () => {
  it("reads data.sessionId from a session.start JSONL event", () => {
    expect(
      extractCopilotSessionId({
        type: "session.start",
        data: {
          sessionId: SESSION_ID,
          version: 1,
          producer: "copilot-agent",
          copilotVersion: "1.0.86",
          startTime: "2026-03-12T12:36:24.489Z",
        },
      }),
    ).toBe(SESSION_ID);
  });

  it("still identifies the session when the empty turn has no assistant.message", () => {
    const emptyTurn = [
      {
        type: "session.start",
        data: { sessionId: SESSION_ID, version: 1, producer: "copilot-agent" },
      },
      {
        type: "user.message",
        data: { content: "summarize the change" },
      },
    ];

    const captured = emptyTurn
      .map(extractCopilotSessionId)
      .find((id): id is string => id !== null);

    expect(captured).toBe(SESSION_ID);
  });

  it("keeps the session id when assistant.message content is empty", () => {
    const emptyFinal = [
      {
        type: "session.start",
        data: { sessionId: SESSION_ID },
      },
      {
        type: "assistant.message",
        data: { content: "", outputTokens: 0 },
      },
    ];

    const captured = emptyFinal
      .map(extractCopilotSessionId)
      .find((id): id is string => id !== null);

    expect(captured).toBe(SESSION_ID);
  });

  it("does not invent a session id from assistant.message or usage events", () => {
    expect(
      extractCopilotSessionId({
        type: "assistant.message",
        data: { content: '{"success":true}', sessionId: SESSION_ID },
      }),
    ).toBeNull();
    expect(
      extractCopilotSessionId({
        type: "usage",
        usage: { inputTokens: 3, outputTokens: 1 },
      }),
    ).toBeNull();
  });

  it("ignores blank or non-string session.start identifiers", () => {
    expect(
      extractCopilotSessionId({
        type: "session.start",
        data: { sessionId: "  " },
      }),
    ).toBeNull();
    expect(
      extractCopilotSessionId({
        type: "session.start",
        data: { sessionId: 12 },
      }),
    ).toBeNull();
  });
});

describe("copilotExactSessionArgs", () => {
  it("resumes the same conversation with --session-id", () => {
    expect(copilotExactSessionArgs(SESSION_ID)).toEqual([
      "--session-id",
      SESSION_ID,
    ]);
  });

  it("refuses recency --continue and the interactive --resume picker", () => {
    const args = copilotExactSessionArgs(SESSION_ID);
    expect(args).not.toContain("--continue");
    expect(args).not.toContain("--resume");
    expect(args).not.toContain("-r");
    expect(args.some((arg) => arg.startsWith("--resume="))).toBe(false);
  });
});

describe("CopilotEmptyTurnError", () => {
  it("is not an empty-response recovery error", () => {
    const error = new CopilotEmptyTurnError(SESSION_ID);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(EmptyAgentResponseError);
    expect(error.message).toBe("copilot returned no agent message");
    expect(error.sessionId).toBe(SESSION_ID);
  });
});
