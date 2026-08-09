import { beforeEach, describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(),
  spawn: vi.fn(),
}));

vi.mock("../debug-log.js", () => ({
  appendDebugLog: vi.fn(),
  initDebugLog: vi.fn(),
  serializeError: vi.fn(),
}));

import { execFileSync, spawn } from "node:child_process";
import { appendDebugLog } from "../debug-log.js";
import { CodexAgent } from "./codex.js";

const mockSpawn = vi.mocked(spawn);
const mockAppendDebugLog = vi.mocked(appendDebugLog);

function createMockProcess() {
  const proc = Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    stdin: null,
    kill: vi.fn(),
  });
  return proc as typeof proc & ReturnType<typeof spawn>;
}

function emitJson(proc: ReturnType<typeof createMockProcess>, event: unknown) {
  proc.stdout.emit("data", Buffer.from(`${JSON.stringify(event)}\n`));
}

function agentMessage(text: string) {
  return {
    type: "item.completed",
    item: { type: "agent_message", text },
  };
}

function turnCompleted(inputTokens: number, outputTokens: number) {
  return {
    type: "turn.completed",
    usage: {
      input_tokens: inputTokens,
      cached_input_tokens: 0,
      output_tokens: outputTokens,
    },
  };
}

const FINAL_OUTPUT = JSON.stringify({
  success: true,
  summary: "recovered",
  key_changes_made: [],
  key_learnings: [],
});

describe("CodexAgent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does not use a shell for direct Windows launches", () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    const agent = new CodexAgent("/tmp/schema.json", {
      platform: "win32",
    });

    agent.run("test prompt", "/work/dir");

    expect(mockSpawn).toHaveBeenCalledWith(
      "codex",
      [
        "exec",
        "test prompt",
        "--json",
        "--output-schema",
        "/tmp/schema.json",
        "--dangerously-bypass-approvals-and-sandbox",
        "--color",
        "never",
      ],
      {
        cwd: "/work/dir",
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        env: process.env,
      },
    );
  });

  it("uses a shell on Windows for cmd wrapper paths", () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    const agent = new CodexAgent("/tmp/schema.json", {
      bin: "C:\\tools\\codex.cmd",
      platform: "win32",
    });

    agent.run("test prompt", "/work/dir");

    expect(mockSpawn).toHaveBeenCalledWith(
      "C:\\tools\\codex.cmd",
      [
        "exec",
        "test prompt",
        "--json",
        "--output-schema",
        "/tmp/schema.json",
        "--dangerously-bypass-approvals-and-sandbox",
        "--color",
        "never",
      ],
      {
        cwd: "/work/dir",
        shell: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: process.env,
      },
    );
  });

  it("uses a shell on Windows when a bare override resolves to a cmd wrapper", () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    vi.mocked(execFileSync).mockReturnValue(
      "C:\\tools\\codex-switch.cmd\r\n" as never,
    );
    const agent = new CodexAgent("/tmp/schema.json", {
      bin: "codex-switch",
      platform: "win32",
    });

    agent.run("test prompt", "/work/dir");

    expect(mockSpawn).toHaveBeenCalledWith(
      "codex-switch",
      [
        "exec",
        "test prompt",
        "--json",
        "--output-schema",
        "/tmp/schema.json",
        "--dangerously-bypass-approvals-and-sandbox",
        "--color",
        "never",
      ],
      {
        cwd: "/work/dir",
        shell: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: process.env,
      },
    );
  });

  it("passes configured extra args through to codex exec", () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    const agent = new CodexAgent("/tmp/schema.json", {
      extraArgs: [
        "-m",
        "gpt-5.4",
        "-c",
        'model_reasoning_effort="high"',
        "--full-auto",
      ],
    });

    agent.run("test prompt", "/work/dir");

    expect(mockSpawn).toHaveBeenCalledWith(
      "codex",
      [
        "exec",
        "-m",
        "gpt-5.4",
        "-c",
        'model_reasoning_effort="high"',
        "--full-auto",
        "test prompt",
        "--json",
        "--output-schema",
        "/tmp/schema.json",
        "--color",
        "never",
      ],
      expect.any(Object),
    );
  });

  it("suppresses the default dangerous flag when the user sets sandbox mode with = syntax", () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    const agent = new CodexAgent("/tmp/schema.json", {
      extraArgs: ["--sandbox=workspace-write"],
    });

    agent.run("test prompt", "/work/dir");

    expect(mockSpawn).toHaveBeenCalledWith(
      "codex",
      [
        "exec",
        "--sandbox=workspace-write",
        "test prompt",
        "--json",
        "--output-schema",
        "/tmp/schema.json",
        "--color",
        "never",
      ],
      expect.any(Object),
    );
  });

  it("kills the full process tree on Windows when aborted", async () => {
    const proc = createMockProcess();
    Object.defineProperty(proc, "pid", { value: 6789 });
    mockSpawn.mockReturnValue(proc);
    const controller = new AbortController();
    const agent = new CodexAgent("/tmp/schema.json", {
      platform: "win32",
    });

    const promise = agent.run("test prompt", "/work/dir", {
      signal: controller.signal,
    });
    controller.abort();

    await expect(promise).rejects.toThrow("Agent was aborted");
    expect(vi.mocked(execFileSync)).toHaveBeenCalledWith(
      "taskkill",
      ["/T", "/F", "/PID", "6789"],
      { stdio: "ignore" },
    );
    expect(proc.kill).not.toHaveBeenCalled();
  });

  it("re-asks once with the bare nudge when a completed turn had no agent message", async () => {
    const first = createMockProcess();
    const second = createMockProcess();
    mockSpawn.mockReturnValueOnce(first).mockReturnValueOnce(second);
    const agent = new CodexAgent("/tmp/schema.json");

    const promise = agent.run("test prompt", "/work/dir");
    emitJson(first, turnCompleted(10, 5));
    first.emit("close", 0);

    await vi.waitFor(() => expect(mockSpawn).toHaveBeenCalledTimes(2));
    emitJson(second, agentMessage(FINAL_OUTPUT));
    emitJson(second, turnCompleted(3, 2));
    second.emit("close", 0);

    await expect(promise).resolves.toMatchObject({
      output: { success: true, summary: "recovered" },
      usage: { inputTokens: 13, outputTokens: 7 },
    });

    const continuationArgs = mockSpawn.mock.calls[1]![1] as string[];
    expect(continuationArgs).toContain(
      "You did not produce a final answer. Continue and provide your final summary now.",
    );
    expect(continuationArgs).toContain("--output-schema");
    expect(mockAppendDebugLog).toHaveBeenCalledWith(
      "codex:output:continuation",
      expect.objectContaining({ attempt: 1 }),
    );
  });

  it("does not re-ask when the turn never completed", async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    const agent = new CodexAgent("/tmp/schema.json");

    const promise = agent.run("test prompt", "/work/dir");
    proc.emit("close", 0);

    await expect(promise).rejects.toThrow("codex returned no agent message");
    expect(mockSpawn).toHaveBeenCalledTimes(1);
    expect(mockAppendDebugLog).not.toHaveBeenCalledWith(
      "codex:output:continuation",
      expect.anything(),
    );
  });

  it("fails after exactly one re-ask when the continuation is also empty", async () => {
    const first = createMockProcess();
    const second = createMockProcess();
    mockSpawn.mockReturnValueOnce(first).mockReturnValueOnce(second);
    const agent = new CodexAgent("/tmp/schema.json");

    const promise = agent.run("test prompt", "/work/dir");
    emitJson(first, turnCompleted(10, 5));
    first.emit("close", 0);

    await vi.waitFor(() => expect(mockSpawn).toHaveBeenCalledTimes(2));
    emitJson(second, turnCompleted(1, 1));
    second.emit("close", 0);

    await expect(promise).rejects.toThrow("codex returned no agent message");
    expect(mockSpawn).toHaveBeenCalledTimes(2);
  });
});
