import { execFileSync, spawn } from "node:child_process";
import {
  buildAgentOutputSchema,
  parseAgentOutput,
  type Agent,
  type AgentOutputSchema,
  type AgentResult,
  type AgentRunOptions,
  type OnMessage,
  type OnUsage,
  type TokenUsage,
} from "./types.js";
import { appendDebugLog } from "../debug-log.js";
import {
  EmptyAgentResponseError,
  runTurnWithEmptyResponseRetry,
} from "./empty-response.js";
import {
  AgentLogFile,
  parseJSONLStream,
  setupAbortHandler,
  setupChildProcessHandlers,
} from "./stream-utils.js";

interface CopilotAssistantMessageEvent {
  type: "assistant.message";
  data: {
    content?: string;
    outputTokens?: number;
  };
}

interface CopilotUsageEvent {
  usage?: Record<string, unknown>;
}

type CopilotEvent =
  | CopilotAssistantMessageEvent
  | (CopilotUsageEvent & { type: string });

const COPILOT_SESSION_ID_KEYS = ["session_id", "sessionId"];

// Copilot's `--continue` picks a session by recency, which is not the same
// thing as picking the turn that just went silent. An empty turn is exactly
// the case where copilot may not have persisted a session at all, so the
// continuation is only safe when copilot itself named a session. Nothing in
// the JSONL contract guarantees that field, so when it is absent gnhf skips
// recovery rather than nudging a session it cannot identify.
function copilotSessionIdOf(event: unknown): string | null {
  if (typeof event !== "object" || event === null) return null;
  const record = event as Record<string, unknown>;
  const containers: unknown[] = [record, record.data, record.session];

  for (const container of containers) {
    if (typeof container !== "object" || container === null) continue;
    for (const key of COPILOT_SESSION_ID_KEYS) {
      const value = (container as Record<string, unknown>)[key];
      if (typeof value === "string" && value) return value;
    }
  }

  return null;
}

interface CopilotAgentDeps {
  bin?: string;
  extraArgs?: string[];
  platform?: NodeJS.Platform;
  schema?: AgentOutputSchema;
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

function terminateCopilotProcess(
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

function userSpecifiedPermissionMode(userArgs: string[]): boolean {
  return userArgs.some(
    (arg) =>
      arg === "--allow-all" ||
      arg === "--yolo" ||
      arg === "--allow-all-tools" ||
      arg === "--allow-all-paths" ||
      arg === "--allow-all-urls" ||
      arg === "--allow-tool" ||
      arg.startsWith("--allow-tool=") ||
      arg === "--allow-url" ||
      arg.startsWith("--allow-url=") ||
      arg === "--deny-tool" ||
      arg.startsWith("--deny-tool=") ||
      arg === "--deny-url" ||
      arg.startsWith("--deny-url=") ||
      arg === "--available-tools" ||
      arg.startsWith("--available-tools=") ||
      arg === "--excluded-tools" ||
      arg.startsWith("--excluded-tools="),
  );
}

function buildCopilotPrompt(prompt: string, schema: AgentOutputSchema): string {
  return `${prompt}

## gnhf final output contract

When the iteration is complete, your final answer must be a single JSON object that matches this JSON Schema:

\`\`\`json
${JSON.stringify(schema, null, 2)}
\`\`\`

Return only the JSON object in the final answer. Do not wrap it in Markdown. Do not include explanatory prose outside the JSON object.`;
}

function buildCopilotArgs(
  prompt: string,
  schema: AgentOutputSchema,
  extraArgs?: string[],
): string[] {
  const userArgs = extraArgs ?? [];

  return [
    ...userArgs,
    "-p",
    buildCopilotPrompt(prompt, schema),
    "--output-format",
    "json",
    "--stream",
    "off",
    "--no-color",
    ...(userSpecifiedPermissionMode(userArgs) ? [] : ["--allow-all"]),
  ];
}

// `--resume <session-id>` reopens that exact session, so the continuation turn
// still sees the first turn's reasoning, tool calls, and the output contract it
// was already given - the nudge itself stays bare.
function buildCopilotResumeArgs(
  prompt: string,
  sessionId: string,
  extraArgs?: string[],
): string[] {
  const userArgs = extraArgs ?? [];

  return [
    ...userArgs,
    "--resume",
    sessionId,
    "-p",
    prompt,
    "--output-format",
    "json",
    "--stream",
    "off",
    "--no-color",
    ...(userSpecifiedPermissionMode(userArgs) ? [] : ["--allow-all"]),
  ];
}

function numberField(
  usage: Record<string, unknown>,
  names: string[],
): number | undefined {
  for (const name of names) {
    const value = usage[name];
    if (typeof value === "number") {
      return value;
    }
  }
  return undefined;
}

function usageFromRecord(usage: Record<string, unknown>): TokenUsage | null {
  const inputTokens = numberField(usage, ["inputTokens", "input_tokens"]);
  const outputTokens = numberField(usage, ["outputTokens", "output_tokens"]);
  const cacheReadTokens = numberField(usage, [
    "cacheReadTokens",
    "cache_read_tokens",
    "cache_read_input_tokens",
  ]);
  const cacheCreationTokens = numberField(usage, [
    "cacheCreationTokens",
    "cacheWriteTokens",
    "cache_creation_tokens",
    "cache_creation_input_tokens",
    "cache_write_tokens",
  ]);

  if (
    inputTokens === undefined &&
    outputTokens === undefined &&
    cacheReadTokens === undefined &&
    cacheCreationTokens === undefined
  ) {
    return null;
  }

  return {
    inputTokens: inputTokens ?? 0,
    outputTokens: outputTokens ?? 0,
    cacheReadTokens: cacheReadTokens ?? 0,
    cacheCreationTokens: cacheCreationTokens ?? 0,
  };
}

export class CopilotAgent implements Agent {
  name = "copilot";

  private bin: string;
  private extraArgs?: string[];
  private platform: NodeJS.Platform;
  private schema: AgentOutputSchema;

  constructor(binOrDeps: string | CopilotAgentDeps = {}) {
    const deps = typeof binOrDeps === "string" ? { bin: binOrDeps } : binOrDeps;
    this.bin = deps.bin ?? "copilot";
    this.extraArgs = deps.extraArgs;
    this.platform = deps.platform ?? process.platform;
    this.schema =
      deps.schema ?? buildAgentOutputSchema({ includeStopField: false });
  }

  async run(
    prompt: string,
    cwd: string,
    options?: AgentRunOptions,
  ): Promise<AgentResult> {
    const { onUsage, onMessage, signal, logPath } = options ?? {};
    const logFile = new AgentLogFile(logPath);
    let sessionId: string | null = null;

    try {
      return await runTurnWithEmptyResponseRetry({
        logEvent: "copilot:output:continuation",
        onUsage,
        initialText: prompt,
        runTurn: (text, onTurnUsage) =>
          this.runTurn(text, cwd, {
            onUsage: onTurnUsage,
            onMessage,
            signal,
            logFile,
            resumeSessionId: sessionId,
            onSessionId: (id) => {
              sessionId = id;
            },
          }),
      });
    } finally {
      logFile.finish();
    }
  }

  private runTurn(
    prompt: string,
    cwd: string,
    options: {
      onUsage?: OnUsage;
      onMessage?: OnMessage;
      signal?: AbortSignal;
      logFile: AgentLogFile;
      resumeSessionId: string | null;
      onSessionId: (sessionId: string) => void;
    },
  ): Promise<AgentResult> {
    const { onUsage, onMessage, signal, logFile } = options;
    const { resumeSessionId, onSessionId } = options;

    return new Promise((resolve, reject) => {
      const child = spawn(
        this.bin,
        resumeSessionId
          ? buildCopilotResumeArgs(prompt, resumeSessionId, this.extraArgs)
          : buildCopilotArgs(prompt, this.schema, this.extraArgs),
        {
          cwd,
          shell: shouldUseWindowsShell(this.bin, this.platform),
          stdio: ["ignore", "pipe", "pipe"],
          env: process.env,
        },
      );
      logFile.track(child);

      if (
        setupAbortHandler(signal, child, reject, () =>
          terminateCopilotProcess(child, this.platform),
        )
      ) {
        return;
      }

      let lastAgentMessage: string | null = null;
      let turnSessionId: string | null = resumeSessionId;
      const cumulative: TokenUsage = {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      };

      parseJSONLStream<CopilotEvent>(child.stdout!, logFile, (event) => {
        const eventSessionId = copilotSessionIdOf(event);
        if (eventSessionId) {
          turnSessionId = eventSessionId;
          onSessionId(eventSessionId);
        }

        if (event.type === "assistant.message") {
          const data = (event as CopilotAssistantMessageEvent).data;
          if (typeof data.content === "string") {
            lastAgentMessage = data.content;
            onMessage?.(data.content);
          }
          if (typeof data.outputTokens === "number") {
            cumulative.outputTokens += data.outputTokens;
            onUsage?.({ ...cumulative });
          }
        }

        if ("usage" in event && event.usage) {
          const usage = usageFromRecord(event.usage);
          if (usage) {
            cumulative.inputTokens = usage.inputTokens;
            cumulative.outputTokens = Math.max(
              cumulative.outputTokens,
              usage.outputTokens,
            );
            cumulative.cacheReadTokens = usage.cacheReadTokens;
            cumulative.cacheCreationTokens = usage.cacheCreationTokens;
            onUsage?.({ ...cumulative });
          }
        }
      });

      setupChildProcessHandlers(child, "copilot", reject, () => {
        if (!lastAgentMessage) {
          const resumeBlockedReason = turnSessionId
            ? null
            : "copilot reported no session id, so the turn cannot be resumed";
          appendDebugLog("copilot:output:missing", {
            hasSessionId: turnSessionId !== null,
            resumeBlockedReason,
          });
          reject(
            new EmptyAgentResponseError(
              resumeBlockedReason
                ? `copilot returned no agent message (${resumeBlockedReason})`
                : "copilot returned no agent message",
              {
                // copilot exposes no end-of-turn event, so a clean exit is the
                // only completion signal it gives.
                turnCompleted: resumeBlockedReason === null,
                usage: cumulative,
              },
            ),
          );
          return;
        }

        try {
          const output = parseAgentOutput(
            lastAgentMessage,
            this.schema,
            "copilot",
          );
          resolve({ output, usage: cumulative });
        } catch (err) {
          reject(
            new Error(
              `Failed to parse copilot output: ${err instanceof Error ? err.message : err}`,
            ),
          );
        }
      });
    });
  }
}
