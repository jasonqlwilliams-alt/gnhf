#!/usr/bin/env node

import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
const sdkPath =
  "/home/jason/.no-mistakes/worktrees/81d474556c1c/01M2V43NQ8J8RQW7Q2K1CN5GJR/node_modules/.pnpm/@agentclientprotocol+sdk@0.21.0_zod@4.4.2/node_modules/@agentclientprotocol/sdk/dist/acp.js";
const { AgentSideConnection, PROTOCOL_VERSION, ndJsonStream } = await import(
  sdkPath
);

const eventLogPath = process.env.GNHF_MOCK_ACP_LOG_PATH;
const mode = process.env.GNHF_MOCK_ACP_MODE ?? "empty-then-recover";

const VALID_OUTPUT = {
  success: true,
  summary: "recovered after empty first turn",
  key_changes_made: ["README.md"],
  key_learnings: ["acp continuation recovered the summary"],
};

function appendLog(event, details = {}) {
  if (!eventLogPath) return;
  appendFileSync(
    eventLogPath,
    `${JSON.stringify({
      timestamp: new Date().toISOString(),
      pid: process.pid,
      event,
      ...details,
    })}\n`,
    "utf-8",
  );
}

class EmptyThenRecoverAgent {
  sessions = new Map();

  constructor(connection) {
    this.connection = connection;
  }

  async initialize() {
    appendLog("agent:initialize");
    return {
      protocolVersion: PROTOCOL_VERSION,
      agentCapabilities: { loadSession: false },
    };
  }

  async authenticate() {
    return {};
  }

  async setSessionMode() {
    return {};
  }

  async newSession(params) {
    const sessionId = `session-${this.sessions.size + 1}`;
    this.sessions.set(sessionId, {
      cwd: params.cwd,
      promptCount: 0,
      pendingPrompt: null,
    });
    appendLog("agent:newSession", { sessionId, cwd: params.cwd });
    return { sessionId };
  }

  async cancel(params) {
    appendLog("agent:cancel", { sessionId: params.sessionId });
    this.sessions.get(params.sessionId)?.pendingPrompt?.abort();
  }

  async prompt(params) {
    const session = this.sessions.get(params.sessionId);
    if (!session) throw new Error(`Unknown session: ${params.sessionId}`);
    session.pendingPrompt?.abort();
    const controller = new AbortController();
    session.pendingPrompt = controller;
    session.promptCount += 1;
    const promptText = JSON.stringify(params.prompt ?? params);
    const isContinuation = promptText.includes(
      "You did not produce a final answer",
    );
    appendLog("agent:prompt:start", {
      sessionId: params.sessionId,
      promptCount: session.promptCount,
      isContinuation,
      mode,
    });

    try {
      if (mode === "empty-then-hang" && isContinuation) {
        appendLog("agent:prompt:hang", { sessionId: params.sessionId });
        await new Promise((_resolve, reject) => {
          controller.signal.addEventListener(
            "abort",
            () => reject(new Error("cancelled")),
            { once: true },
          );
        });
      }

      if (
        mode === "always-empty" ||
        (mode === "empty-then-recover" && !isContinuation) ||
        (mode === "empty-then-hang" && !isContinuation)
      ) {
        if (session.cwd) {
          appendFileSync(
            join(session.cwd, "README.md"),
            `- empty acp work ${Date.now()}\n`,
            "utf-8",
          );
        }
        appendLog("agent:prompt:empty", {
          sessionId: params.sessionId,
          promptCount: session.promptCount,
          workspaceChanged: Boolean(session.cwd),
        });
        return { stopReason: "end_turn" };
      }

      await this.connection.sessionUpdate({
        sessionId: params.sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: {
            type: "text",
            text: JSON.stringify(VALID_OUTPUT),
          },
        },
      });
      appendLog("agent:prompt:done", {
        sessionId: params.sessionId,
        promptCount: session.promptCount,
      });
      return { stopReason: "end_turn" };
    } catch (error) {
      if (controller.signal.aborted) {
        appendLog("agent:prompt:cancelled", {
          sessionId: params.sessionId,
        });
        return { stopReason: "cancelled" };
      }
      throw error;
    } finally {
      if (session.pendingPrompt === controller) session.pendingPrompt = null;
    }
  }
}

new AgentSideConnection(
  (conn) => new EmptyThenRecoverAgent(conn),
  ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)),
);
appendLog("process:ready", { mode });
