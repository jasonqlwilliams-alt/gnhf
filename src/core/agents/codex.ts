import { execFileSync, spawn } from "node:child_process";
import { createWriteStream, type WriteStream } from "node:fs";
import type {
  Agent,
  AgentResult,
  AgentOutput,
  OnMessage,
  OnUsage,
  TokenUsage,
  AgentRunOptions,
} from "./types.js";
import { appendDebugLog } from "../debug-log.js";
import {
  EmptyAgentResponseError,
  runTurnWithEmptyResponseRetry,
} from "./empty-response.js";
import {
  parseJSONLStream,
  setupAbortHandler,
  setupChildProcessHandlers,
} from "./stream-utils.js";

interface CodexItemCompleted {
  type: "item.completed";
  item: { type: string; text: string };
}

interface CodexTurnCompleted {
  type: "turn.completed";
  usage: {
    input_tokens: number;
    cached_input_tokens: number;
    output_tokens: number;
  };
}

type CodexEvent = CodexItemCompleted | CodexTurnCompleted | { type: string };

interface CodexAgentDeps {
  bin?: string;
  extraArgs?: string[];
  platform?: NodeJS.Platform;
}

function shouldUseWindowsShell(
  bin: string,
  platform: NodeJS.Platform,
): boolean {
  if (platform !== "win32") {
    return false;
  }

  if (/\.(cmd|bat)$/i.test(bin)) {
    return true;
  }

  if (/[\\/]/.test(bin)) {
    return false;
  }

  try {
    const resolved = execFileSync("where", [bin], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const firstMatch = resolved
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean);
    return firstMatch ? /\.(cmd|bat)$/i.test(firstMatch) : false;
  } catch {
    return false;
  }
}

function terminateCodexProcess(
  child: ReturnType<typeof spawn>,
  platform: NodeJS.Platform,
): void {
  if (platform === "win32" && child.pid) {
    try {
      execFileSync("taskkill", ["/T", "/F", "/PID", String(child.pid)], {
        stdio: "ignore",
      });
    } catch {
      // Best-effort: the process may have already exited.
    }
    return;
  }

  child.kill("SIGTERM");
}

function buildCodexArgs(
  prompt: string,
  schemaPath: string,
  extraArgs?: string[],
): string[] {
  const userArgs = extraArgs ?? [];
  const userSpecifiedExecutionMode = userArgs.some(
    (arg) =>
      arg === "--full-auto" ||
      arg === "--dangerously-bypass-approvals-and-sandbox" ||
      arg === "--sandbox" ||
      arg.startsWith("--sandbox=") ||
      arg === "-s" ||
      arg === "--ask-for-approval" ||
      arg.startsWith("--ask-for-approval=") ||
      arg === "-a",
  );

  return [
    "exec",
    ...userArgs,
    prompt,
    "--json",
    "--output-schema",
    schemaPath,
    ...(userSpecifiedExecutionMode
      ? []
      : ["--dangerously-bypass-approvals-and-sandbox"]),
    "--color",
    "never",
  ];
}

export class CodexAgent implements Agent {
  name = "codex";

  private bin: string;
  private extraArgs?: string[];
  private platform: NodeJS.Platform;
  private schemaPath: string;

  constructor(schemaPath: string, binOrDeps: string | CodexAgentDeps = {}) {
    const deps = typeof binOrDeps === "string" ? { bin: binOrDeps } : binOrDeps;
    this.bin = deps.bin ?? "codex";
    this.extraArgs = deps.extraArgs;
    this.platform = deps.platform ?? process.platform;
    this.schemaPath = schemaPath;
  }

  async run(
    prompt: string,
    cwd: string,
    options?: AgentRunOptions,
  ): Promise<AgentResult> {
    const { onUsage, onMessage, signal, logPath } = options ?? {};
    const logStream = logPath ? createWriteStream(logPath) : null;

    try {
      // `--output-schema` is a spawn flag, so the continuation turn carries the
      // same output contract without any extra prompt scaffolding.
      return await runTurnWithEmptyResponseRetry({
        logEvent: "codex:output:continuation",
        onUsage,
        initialText: prompt,
        runTurn: (text, onTurnUsage) =>
          this.runTurn(text, cwd, {
            onUsage: onTurnUsage,
            onMessage,
            signal,
            logStream,
          }),
      });
    } finally {
      logStream?.end();
    }
  }

  private runTurn(
    prompt: string,
    cwd: string,
    options: {
      onUsage?: OnUsage;
      onMessage?: OnMessage;
      signal?: AbortSignal;
      logStream: WriteStream | null;
    },
  ): Promise<AgentResult> {
    const { onUsage, onMessage, signal, logStream } = options;

    return new Promise((resolve, reject) => {
      const child = spawn(
        this.bin,
        buildCodexArgs(prompt, this.schemaPath, this.extraArgs),
        {
          cwd,
          shell: shouldUseWindowsShell(this.bin, this.platform),
          stdio: ["ignore", "pipe", "pipe"],
          env: process.env,
        },
      );

      if (
        setupAbortHandler(signal, child, reject, () =>
          terminateCodexProcess(child, this.platform),
        )
      ) {
        return;
      }

      let lastAgentMessage: string | null = null;
      // `turn.completed` is codex's own end-of-turn signal, so it - not a
      // clean process exit - is what separates a finished-but-silent turn
      // from a turn that never got to answer.
      let sawTurnCompleted = false;
      const cumulative: TokenUsage = {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      };

      parseJSONLStream<CodexEvent>(child.stdout!, logStream, (event) => {
        if (
          event.type === "item.completed" &&
          "item" in event &&
          (event as CodexItemCompleted).item.type === "agent_message"
        ) {
          lastAgentMessage = (event as CodexItemCompleted).item.text;
          onMessage?.(lastAgentMessage);
        }

        if (event.type === "turn.completed") {
          sawTurnCompleted = true;
          if ("usage" in event) {
            const u = (event as CodexTurnCompleted).usage;
            cumulative.inputTokens += u.input_tokens ?? 0;
            cumulative.outputTokens += u.output_tokens ?? 0;
            cumulative.cacheReadTokens += u.cached_input_tokens ?? 0;
            onUsage?.({ ...cumulative });
          }
        }
      });

      setupChildProcessHandlers(child, "codex", reject, () => {
        if (!lastAgentMessage) {
          appendDebugLog("codex:output:missing", { sawTurnCompleted });
          reject(
            new EmptyAgentResponseError("codex returned no agent message", {
              turnCompleted: sawTurnCompleted,
              usage: cumulative,
            }),
          );
          return;
        }

        try {
          const output = JSON.parse(lastAgentMessage) as AgentOutput;
          resolve({ output, usage: cumulative });
        } catch (err) {
          reject(
            new Error(
              `Failed to parse codex output: ${err instanceof Error ? err.message : err}`,
            ),
          );
        }
      });
    });
  }
}
