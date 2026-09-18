import { beforeEach, describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(),
  spawn: vi.fn(),
}));

import { execFileSync, spawn } from "node:child_process";
import { CopilotAgent } from "./copilot.js";
import { CopilotEmptyTurnError } from "./copilot-session.js";
import {
  EMPTY_RESPONSE_CONTINUATION_PROMPT,
  EmptyAgentResponseError,
} from "./empty-response.js";
import { buildAgentOutputSchema } from "./types.js";

const COPILOT_SESSION_ID = "0cb916db-26aa-40f2-86b5-1ba81b225fd2";

const mockSpawn = vi.mocked(spawn);

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

function spawnArgs(callIndex: number): string[] {
  return mockSpawn.mock.calls[callIndex]![1] as string[];
}

function expectExactSessionResume(args: string[], sessionId: string): void {
  const sessionFlagAt = args.indexOf("--session-id");
  expect(sessionFlagAt).toBeGreaterThanOrEqual(0);
  expect(args[sessionFlagAt + 1]).toBe(sessionId);
  expect(args).not.toContain("--continue");
  expect(args).not.toContain("--resume");
  expect(args).not.toContain("-r");
  expect(args.some((arg) => arg.startsWith("--resume="))).toBe(false);
  expect(args.some((arg) => arg.startsWith("--session-id="))).toBe(false);
}

function recoveredOutput(summary: string) {
  return {
    success: true,
    summary,
    key_changes_made: [],
    key_learnings: [],
  };
}

describe("CopilotAgent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("spawns copilot in non-interactive JSONL mode with the default permission flag", () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    const agent = new CopilotAgent({ platform: "win32" });

    agent.run("test prompt", "/work/dir");

    const args = mockSpawn.mock.calls[0]![1] as string[];
    expect(mockSpawn).toHaveBeenCalledWith("copilot", args, {
      cwd: "/work/dir",
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    expect(args[0]).toBe("-p");
    expect(args[1]).toContain("test prompt");
    expect(args[1]).toContain("gnhf final output contract");
    expect(args).toEqual(
      expect.arrayContaining([
        "--output-format",
        "json",
        "--stream",
        "off",
        "--no-color",
        "--allow-all",
      ]),
    );
    expect(args).not.toContain("--continue");
    expect(args).not.toContain("--resume");
    expect(args).not.toContain("-r");
    expect(args).not.toContain("--session-id");
  });

  it("uses a shell on Windows for cmd wrapper paths", () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    const agent = new CopilotAgent({
      bin: "C:\\tools\\copilot.cmd",
      platform: "win32",
    });

    agent.run("test prompt", "/work/dir");

    expect(mockSpawn).toHaveBeenCalledWith(
      "C:\\tools\\copilot.cmd",
      expect.any(Array),
      expect.objectContaining({ shell: true }),
    );
  });

  it("uses a shell on Windows when a bare override resolves to a cmd wrapper", () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    vi.mocked(execFileSync).mockReturnValue(
      "C:\\tools\\copilot-switch.cmd\r\n" as never,
    );
    const agent = new CopilotAgent({
      bin: "copilot-switch",
      platform: "win32",
    });

    agent.run("test prompt", "/work/dir");

    expect(mockSpawn).toHaveBeenCalledWith(
      "copilot-switch",
      expect.any(Array),
      expect.objectContaining({ shell: true }),
    );
  });

  it("passes configured extra args through and suppresses the default permission flag", () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    const agent = new CopilotAgent({
      extraArgs: ["--model", "gpt-5.4", "--allow-all-tools"],
    });

    agent.run("test prompt", "/work/dir");

    const args = mockSpawn.mock.calls[0]![1] as string[];
    expect(args.slice(0, 3)).toEqual([
      "--model",
      "gpt-5.4",
      "--allow-all-tools",
    ]);
    expect(args).not.toContain("--allow-all");
  });

  it("adds the configured model before the prompt flag", () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    const agent = new CopilotAgent({
      model: "gpt-5.4",
    });

    agent.run("test prompt", "/work/dir");

    const args = mockSpawn.mock.calls[0]![1] as string[];
    expect(args.slice(0, 3)).toEqual(["--model", "gpt-5.4", "-p"]);
  });

  it("kills the full process tree on Windows when aborted", async () => {
    const proc = createMockProcess();
    Object.defineProperty(proc, "pid", { value: 6789 });
    mockSpawn.mockReturnValue(proc);
    const controller = new AbortController();
    const agent = new CopilotAgent({ platform: "win32" });

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

  it("parses the final assistant message and accumulates output tokens", async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    const onMessage = vi.fn();
    const onUsage = vi.fn();
    const agent = new CopilotAgent();
    const content = JSON.stringify({
      success: true,
      summary: "ok",
      key_changes_made: [],
      key_learnings: [],
    });

    const promise = agent.run("test prompt", "/work/dir", {
      onMessage,
      onUsage,
    });
    emitJson(proc, {
      type: "assistant.message",
      data: { content, outputTokens: 7 },
    });
    proc.emit("close", 0);

    await expect(promise).resolves.toEqual({
      output: {
        success: true,
        summary: "ok",
        key_changes_made: [],
        key_learnings: [],
      },
      usage: {
        inputTokens: 0,
        outputTokens: 7,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      },
    });
    expect(onMessage).toHaveBeenCalledWith(content);
    expect(onUsage).toHaveBeenCalledWith({
      inputTokens: 0,
      outputTokens: 7,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    });
  });

  it("accepts a fenced JSON final answer", async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    const agent = new CopilotAgent();

    const promise = agent.run("test prompt", "/work/dir");
    emitJson(proc, {
      type: "assistant.message",
      data: {
        content:
          '```json\n{"success":true,"summary":"ok","key_changes_made":[],"key_learnings":[]}\n```',
      },
    });
    proc.emit("close", 0);

    await expect(promise).resolves.toMatchObject({
      output: {
        success: true,
        summary: "ok",
      },
    });
  });

  it("recovers JSON when copilot prepends prose before the final object", async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    const agent = new CopilotAgent();

    const promise = agent.run("test prompt", "/work/dir");
    emitJson(proc, {
      type: "assistant.message",
      data: {
        content:
          'Good - all tests pass.\n\n{"success":true,"summary":"ok","key_changes_made":[],"key_learnings":[]}',
      },
    });
    proc.emit("close", 0);

    await expect(promise).resolves.toMatchObject({
      output: {
        success: true,
        summary: "ok",
      },
    });
  });

  it("recovers fenced JSON when copilot writes prose before the fence", async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    const agent = new CopilotAgent();

    const promise = agent.run("test prompt", "/work/dir");
    emitJson(proc, {
      type: "assistant.message",
      data: {
        content:
          'Done.\n\n```json\n{"success":true,"summary":"ok","key_changes_made":[],"key_learnings":[]}\n```',
      },
    });
    proc.emit("close", 0);

    await expect(promise).resolves.toMatchObject({
      output: {
        success: true,
        summary: "ok",
      },
    });
  });

  it("includes should_fully_stop in the prompt contract when the schema requires it", () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    const agent = new CopilotAgent({
      schema: buildAgentOutputSchema({ includeStopField: true }),
    });

    agent.run("test prompt", "/work/dir");

    const args = mockSpawn.mock.calls[0]![1] as string[];
    expect(args[1]).toContain("should_fully_stop");
  });

  it("rejects when copilot returns no assistant message", async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    const agent = new CopilotAgent();

    const promise = agent.run("test prompt", "/work/dir");
    proc.emit("close", 0);

    await expect(promise).rejects.toMatchObject({
      name: "CopilotEmptyTurnError",
      message: "copilot returned no agent message",
      sessionId: null,
    });
    await expect(promise).rejects.not.toBeInstanceOf(EmptyAgentResponseError);
    expect(mockSpawn).toHaveBeenCalledTimes(1);
  });

  it("continues the same session once when the first turn has no agent message", async () => {
    const first = createMockProcess();
    const second = createMockProcess();
    mockSpawn.mockReturnValueOnce(first).mockReturnValueOnce(second);
    const agent = new CopilotAgent();
    const content = JSON.stringify(recoveredOutput("recovered"));

    const promise = agent.run("test prompt", "/work/dir");
    emitJson(first, {
      type: "session.start",
      data: {
        sessionId: COPILOT_SESSION_ID,
        version: 1,
        producer: "copilot-agent",
      },
    });
    emitJson(first, {
      type: "assistant.message",
      data: { content: "", outputTokens: 1 },
    });
    first.emit("close", 0);

    await vi.waitFor(() => {
      expect(mockSpawn).toHaveBeenCalledTimes(2);
    });

    emitJson(second, {
      type: "assistant.message",
      data: { content, outputTokens: 7 },
    });
    second.emit("close", 0);

    await expect(promise).resolves.toEqual({
      output: recoveredOutput("recovered"),
      usage: {
        inputTokens: 0,
        outputTokens: 8,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      },
    });

    const firstArgs = spawnArgs(0);
    const secondArgs = spawnArgs(1);
    expect(firstArgs).not.toContain("--session-id");
    expect(firstArgs[firstArgs.indexOf("-p") + 1]).toContain("test prompt");
    expect(firstArgs).not.toContain("--continue");
    expect(firstArgs).not.toContain("--resume");
    expectExactSessionResume(secondArgs, COPILOT_SESSION_ID);
    expect(secondArgs[secondArgs.indexOf("-p") + 1]).toContain(
      EMPTY_RESPONSE_CONTINUATION_PROMPT,
    );
    expect(mockSpawn).toHaveBeenCalledTimes(2);
  });

  it("records the original failure when the retry is still empty", async () => {
    const first = createMockProcess();
    const second = createMockProcess();
    mockSpawn.mockReturnValueOnce(first).mockReturnValueOnce(second);
    const agent = new CopilotAgent();

    const promise = agent.run("test prompt", "/work/dir");
    emitJson(first, {
      type: "session.start",
      data: {
        sessionId: COPILOT_SESSION_ID,
        version: 1,
        producer: "copilot-agent",
      },
    });
    first.emit("close", 0);

    await vi.waitFor(() => {
      expect(mockSpawn).toHaveBeenCalledTimes(2);
    });

    second.emit("close", 0);

    await expect(promise).rejects.toMatchObject({
      name: "CopilotEmptyTurnError",
      message: "copilot returned no agent message",
    });
    await expect(promise).rejects.toBeInstanceOf(CopilotEmptyTurnError);
    expectExactSessionResume(spawnArgs(1), COPILOT_SESSION_ID);
    expect(spawnArgs(1)[spawnArgs(1).indexOf("-p") + 1]).toContain(
      EMPTY_RESPONSE_CONTINUATION_PROMPT,
    );
    expect(mockSpawn).toHaveBeenCalledTimes(2);
  });

  it("aborts a continuation instead of recording an empty-response failure", async () => {
    const first = createMockProcess();
    const second = createMockProcess();
    mockSpawn.mockReturnValueOnce(first).mockReturnValueOnce(second);
    const controller = new AbortController();
    const agent = new CopilotAgent();

    const promise = agent.run("test prompt", "/work/dir", {
      signal: controller.signal,
    });
    emitJson(first, {
      type: "session.start",
      data: {
        sessionId: COPILOT_SESSION_ID,
        version: 1,
        producer: "copilot-agent",
      },
    });
    first.emit("close", 0);

    await vi.waitFor(() => {
      expect(mockSpawn).toHaveBeenCalledTimes(2);
    });

    controller.abort();

    await expect(promise).rejects.toThrow("Agent was aborted");
    await expect(promise).rejects.not.toBeInstanceOf(EmptyAgentResponseError);
    await expect(promise).rejects.not.toBeInstanceOf(CopilotEmptyTurnError);
    expectExactSessionResume(spawnArgs(1), COPILOT_SESSION_ID);
    expect(mockSpawn).toHaveBeenCalledTimes(2);
  });

  it("resumes that empty turn with --session-id and never --continue or --resume", () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    const agent = new CopilotAgent({ sessionId: COPILOT_SESSION_ID });

    agent.run("You did not produce a final answer. Continue.", "/work/dir");

    expectExactSessionResume(spawnArgs(0), COPILOT_SESSION_ID);
  });

  it("rejects when the final assistant message is not valid JSON", async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    const agent = new CopilotAgent();

    const promise = agent.run("test prompt", "/work/dir");
    emitJson(proc, {
      type: "assistant.message",
      data: { content: "not json" },
    });
    proc.emit("close", 0);

    await expect(promise).rejects.toThrow("Failed to parse copilot output");
  });

  it("rejects when the final assistant message misses required fields", async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    const agent = new CopilotAgent();

    const promise = agent.run("test prompt", "/work/dir");
    emitJson(proc, {
      type: "assistant.message",
      data: { content: '{"success":true,"summary":"ok"}' },
    });
    proc.emit("close", 0);

    await expect(promise).rejects.toThrow("Failed to parse copilot output");
  });

  it("rejects commit fields that do not match the schema enum", async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    const agent = new CopilotAgent({
      schema: buildAgentOutputSchema({
        includeStopField: false,
        commitFields: [{ name: "commit_type", allowed: ["feat", "fix"] }],
      }),
    });

    const promise = agent.run("test prompt", "/work/dir");
    emitJson(proc, {
      type: "assistant.message",
      data: {
        content: JSON.stringify({
          success: true,
          summary: "ok",
          key_changes_made: [],
          key_learnings: [],
          commit_type: "chore",
        }),
      },
    });
    proc.emit("close", 0);

    await expect(promise).rejects.toThrow("Failed to parse copilot output");
  });

  it("surfaces a structured error emitted on stdout after a non-zero exit", async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    const agent = new CopilotAgent();

    const promise = agent.run("test prompt", "/work/dir");
    emitJson(proc, { type: "error", error: { message: "login required" } });
    proc.emit("close", 1);

    await expect(promise).rejects.toThrow(
      "copilot exited with code 1: login required",
    );
  });
});
