#!/usr/bin/env node

import { execFileSync, spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  chmodSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const evidenceDir = dirname(fileURLToPath(import.meta.url));
const mocksDir = join(evidenceDir, "mocks");
const resultsDir = join(evidenceDir, "results");
const worktree =
  "/home/jason/.no-mistakes/worktrees/81d474556c1c/01M2V43NQ8J8RQW7Q2K1CN5GJR";
const distCliPath = join(worktree, "dist", "cli.mjs");
const nodeBin = process.execPath;

mkdirSync(resultsDir, { recursive: true });
chmodSync(join(mocksDir, "opencode"), 0o755);
chmodSync(join(mocksDir, "copilot"), 0o755);

const emptyGitConfigDir = mkdtempSync(join(tmpdir(), "gnhf-live-gitconfig-"));
const emptyGitConfigPath = join(emptyGitConfigDir, "gitconfig");
writeFileSync(emptyGitConfigPath, "", "utf-8");

const sanitizedGitEnv = {
  GIT_CONFIG_GLOBAL: emptyGitConfigPath,
  GIT_CONFIG_SYSTEM: emptyGitConfigPath,
  GIT_TERMINAL_PROMPT: "0",
};

function git(args, cwd) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...sanitizedGitEnv },
  }).trim();
}

function createRepo() {
  const cwd = mkdtempSync(join(tmpdir(), "gnhf-live-empty-"));
  git(["init", "-b", "main"], cwd);
  git(["config", "user.name", "gnhf live"], cwd);
  git(["config", "user.email", "live@example.com"], cwd);
  writeFileSync(join(cwd, "README.md"), "# fixture\n", "utf-8");
  git(["add", "README.md"], cwd);
  git(["commit", "-m", "init"], cwd);
  return cwd;
}

function readJsonLines(filePath) {
  if (!existsSync(filePath)) return [];
  return readFileSync(filePath, "utf-8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function findRunLogPath(cwd) {
  const runsDir = join(cwd, ".gnhf", "runs");
  const runs = readdirSync(runsDir);
  if (runs.length !== 1) {
    throw new Error(`Expected one run in ${runsDir}, found ${runs.length}`);
  }
  return join(runsDir, runs[0], "gnhf.log");
}

function waitForLogEvent(filePath, event, timeoutMs = 15_000) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const tick = () => {
      const match = readJsonLines(filePath).find((entry) => entry.event === event);
      if (match) {
        resolve(match);
        return;
      }
      if (Date.now() > deadline) {
        reject(new Error(`Timed out waiting for ${event} in ${filePath}`));
        return;
      }
      setTimeout(tick, 50);
    };
    tick();
  });
}

function runCli(cwd, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(nodeBin, [distCliPath, ...args], {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      resolve({ code, signal, stdout, stderr, pid: child.pid });
    });
    child.stdin.end();
  });
}

function createHome(configYaml) {
  const home = mkdtempSync(join(tmpdir(), "gnhf-live-home-"));
  mkdirSync(join(home, ".gnhf"), { recursive: true });
  writeFileSync(join(home, ".gnhf", "config.yml"), configYaml, "utf-8");
  return home;
}

function baseEnv(home, extra = {}) {
  return {
    ...process.env,
    ...sanitizedGitEnv,
    HOME: home,
    USERPROFILE: home,
    PATH: `${mocksDir}:${process.env.PATH ?? ""}`,
    ...extra,
  };
}

function writeResult(name, payload) {
  const path = join(resultsDir, `${name}.json`);
  writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`, "utf-8");
  return path;
}

function freshLog(name) {
  const path = join(resultsDir, `${name}-mock.jsonl`);
  rmSync(path, { force: true });
  return path;
}

const scenarios = [];

async function runEmptyThenRecoverOpenCode() {
  const name = "opencode-empty-then-recover";
  const cwd = createRepo();
  const mockLogPath = freshLog(name);
  const home = createHome("preventSleep: false\n");
  const result = await runCli(
    cwd,
    [
      "recover the empty turn",
      "--agent",
      "opencode",
      "--max-iterations",
      "1",
      "--prevent-sleep",
      "off",
    ],
    baseEnv(home, {
      GNHF_MOCK_OPENCODE_LOG_PATH: mockLogPath,
      GNHF_MOCK_OPENCODE_MODE: "empty-then-recover",
    }),
  );
  const debugLogPath = findRunLogPath(cwd);
  const debugEntries = readJsonLines(debugLogPath);
  const mockEntries = readJsonLines(mockLogPath);
  const commitCount = git(["rev-list", "--count", "HEAD"], cwd);
  const lastSubject = git(["log", "-1", "--format=%s"], cwd);
  const continuation = debugEntries.find(
    (e) => e.event === "opencode:output:continuation",
  );
  const iterationEnd = debugEntries.find((e) => e.event === "iteration:end");
  const prompts = mockEntries.filter((e) => e.event === "message:start");
  const payload = {
    name,
    cwd,
    debugLogPath,
    mockLogPath,
    code: result.code,
    stdout: result.stdout,
    stderr: result.stderr,
    commitCount,
    lastSubject,
    continuation,
    iterationEnd,
    prompts: prompts.map((p) => ({
      promptCount: p.promptCount,
      isContinuation: p.isContinuation,
      promptPreview: String(p.prompt).slice(0, 120),
    })),
    debugEvents: debugEntries.map((e) => e.event),
  };
  writeResult(name, payload);
  const pass =
    result.code === 0 &&
    commitCount === "2" &&
    lastSubject.includes("gnhf 1:") &&
    continuation?.attempt === 1 &&
    iterationEnd?.success === true &&
    prompts.length === 2 &&
    prompts[1].isContinuation === true;
  scenarios.push({
    name: "OpenCode empty first turn recovers via one same-session continuation and commits",
    result: pass ? "pass" : "fail",
    live: true,
    evidence: writeResult(name, payload),
    reason: pass
      ? "CLI recovered after one continuation and committed the iteration"
      : `code=${result.code} commits=${commitCount} continuation=${Boolean(continuation)} success=${iterationEnd?.success} prompts=${prompts.length}`,
  });
}

async function runAlwaysEmptyOpenCode() {
  const name = "opencode-still-empty";
  const cwd = createRepo();
  const mockLogPath = freshLog(name);
  const home = createHome("preventSleep: false\n");
  const result = await runCli(
    cwd,
    [
      "empty twice should fail once",
      "--agent",
      "opencode",
      "--max-iterations",
      "1",
      "--prevent-sleep",
      "off",
    ],
    baseEnv(home, {
      GNHF_MOCK_OPENCODE_LOG_PATH: mockLogPath,
      GNHF_MOCK_OPENCODE_MODE: "always-empty",
    }),
  );
  const debugLogPath = findRunLogPath(cwd);
  const debugEntries = readJsonLines(debugLogPath);
  const mockEntries = readJsonLines(mockLogPath);
  const commitCount = git(["rev-list", "--count", "HEAD"], cwd);
  const workingTree = git(["status", "--porcelain"], cwd);
  const continuation = debugEntries.find(
    (e) => e.event === "opencode:output:continuation",
  );
  const agentError = debugEntries.find((e) => e.event === "agent:run:error");
  const iterationEnd = debugEntries.find((e) => e.event === "iteration:end");
  const prompts = mockEntries.filter((e) => e.event === "message:start");
  const payload = {
    name,
    cwd,
    debugLogPath,
    mockLogPath,
    code: result.code,
    stdout: result.stdout,
    stderr: result.stderr,
    commitCount,
    workingTree,
    continuation,
    agentError,
    iterationEnd,
    prompts: prompts.map((p) => ({
      promptCount: p.promptCount,
      isContinuation: p.isContinuation,
    })),
    debugEvents: debugEntries.map((e) => e.event),
  };
  writeResult(name, payload);
  const pass =
    commitCount === "1" &&
    workingTree === "" &&
    continuation?.attempt === 1 &&
    prompts.length === 2 &&
    String(agentError?.error?.message ?? "").includes(
      "OpenCode produced no final answer",
    ) &&
    iterationEnd?.success === false &&
    !debugEntries.some(
      (e) => e.event === "opencode:output:continuation" && e.attempt === 2,
    );
  scenarios.push({
    name: "OpenCode still-empty continuation records one failure and rolls back the work",
    result: pass ? "pass" : "fail",
    live: true,
    evidence: writeResult(name, payload),
    reason: pass
      ? "Exactly one continuation, original empty-response failure, work rolled back"
      : `commits=${commitCount} dirty=${JSON.stringify(workingTree)} prompts=${prompts.length} error=${agentError?.error?.message}`,
  });
}

async function runProviderErrorOpenCode() {
  const name = "opencode-provider-error";
  const cwd = createRepo();
  const mockLogPath = freshLog(name);
  const home = createHome("preventSleep: false\n");
  const result = await runCli(
    cwd,
    [
      "provider error must not continue",
      "--agent",
      "opencode",
      "--max-iterations",
      "1",
      "--prevent-sleep",
      "off",
    ],
    baseEnv(home, {
      GNHF_MOCK_OPENCODE_LOG_PATH: mockLogPath,
      GNHF_MOCK_OPENCODE_MODE: "overload",
    }),
  );
  const debugLogPath = findRunLogPath(cwd);
  const debugEntries = readJsonLines(debugLogPath);
  const mockEntries = readJsonLines(mockLogPath);
  const continuation = debugEntries.find(
    (e) => e.event === "opencode:output:continuation",
  );
  const agentError = debugEntries.find((e) => e.event === "agent:run:error");
  const prompts = mockEntries.filter((e) => e.event === "message:start");
  const payload = {
    name,
    cwd,
    debugLogPath,
    mockLogPath,
    code: result.code,
    stdout: result.stdout,
    stderr: result.stderr,
    continuation,
    agentError,
    prompts: prompts.map((p) => ({
      promptCount: p.promptCount,
      isContinuation: p.isContinuation,
    })),
    debugEvents: debugEntries.map((e) => e.event),
  };
  writeResult(name, payload);
  const pass =
    !continuation &&
    prompts.length === 1 &&
    String(agentError?.error?.message ?? "").includes(
      "OpenCode provider overloaded",
    );
  scenarios.push({
    name: "OpenCode provider stream error is not recovered as an empty answer",
    result: pass ? "pass" : "fail",
    live: true,
    evidence: writeResult(name, payload),
    reason: pass
      ? "Provider error failed immediately with no continuation"
      : `continuation=${Boolean(continuation)} prompts=${prompts.length} error=${agentError?.error?.message}`,
  });
}

async function runInterruptDuringContinuation() {
  const name = "opencode-interrupt-continuation";
  const cwd = createRepo();
  const mockLogPath = freshLog(name);
  const home = createHome("preventSleep: false\n");
  const env = baseEnv(home, {
    GNHF_MOCK_OPENCODE_LOG_PATH: mockLogPath,
    GNHF_MOCK_OPENCODE_MODE: "empty-then-hang",
  });
  const child = spawn(
    nodeBin,
    [
      distCliPath,
      "interrupt the continuation",
      "--agent",
      "opencode",
      "--prevent-sleep",
      "off",
    ],
    { cwd, env, stdio: ["pipe", "pipe", "pipe"] },
  );
  child.stdin.end();
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  const exitPromise = new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code, signal) => {
      resolve({ code, signal });
    });
  });
  await waitForLogEvent(mockLogPath, "message:hang", 20_000);
  child.kill("SIGINT");
  await new Promise((r) => setTimeout(r, 80));
  child.kill("SIGINT");
  const exit = await exitPromise;
  const debugLogPath = findRunLogPath(cwd);
  const debugEntries = readJsonLines(debugLogPath);
  const continuation = debugEntries.find(
    (e) => e.event === "opencode:output:continuation",
  );
  const agentError = debugEntries.find((e) => e.event === "agent:run:error");
  const aborted = debugEntries.find(
    (e) =>
      e.event === "opencode:run:aborted" ||
      e.event === "agent:run:aborted" ||
      e.event === "agent:run:stopped" ||
      e.event === "iteration:stopped",
  );
  const payload = {
    name,
    cwd,
    debugLogPath,
    mockLogPath,
    code: exit.code,
    signal: exit.signal,
    stdout,
    stderr,
    continuation,
    agentError,
    aborted,
    debugEvents: debugEntries.map((e) => e.event),
  };
  writeResult(name, payload);
  const errorMessage = String(agentError?.error?.message ?? "");
  const pass =
    exit.code === 130 &&
    continuation?.attempt === 1 &&
    Boolean(aborted) &&
    !errorMessage.includes("OpenCode produced no final answer") &&
    !debugEntries.some((e) => e.event === "iteration:end" && e.success === false);
  scenarios.push({
    name: "Interrupt during the empty-answer continuation aborts instead of recording a failure",
    result: pass ? "pass" : "fail",
    live: true,
    evidence: writeResult(name, payload),
    reason: pass
      ? "Force-stop aborted the hung continuation without an empty-response failure"
      : `code=${exit.code} aborted=${Boolean(aborted)} error=${errorMessage}`,
  });
}

async function runCopilotDoesNotContinue() {
  const name = "copilot-no-continuation";
  const cwd = createRepo();
  const mockLogPath = freshLog(name);
  writeFileSync(mockLogPath, "", "utf-8");
  const home = createHome(
    [
      "preventSleep: false",
      "agentPathOverride:",
      `  copilot: ${join(mocksDir, "copilot")}`,
      "",
    ].join("\n"),
  );
  const result = await runCli(
    cwd,
    [
      "copilot empty must fail immediately",
      "--agent",
      "copilot",
      "--max-iterations",
      "1",
      "--prevent-sleep",
      "off",
    ],
    baseEnv(home, {
      GNHF_MOCK_COPILOT_LOG_PATH: mockLogPath,
    }),
  );
  const debugLogPath = findRunLogPath(cwd);
  const debugEntries = readJsonLines(debugLogPath);
  const mockEntries = readJsonLines(mockLogPath);
  const agentError = debugEntries.find((e) => e.event === "agent:run:error");
  const payload = {
    name,
    cwd,
    debugLogPath,
    mockLogPath,
    code: result.code,
    stdout: result.stdout,
    stderr: result.stderr,
    agentError,
    mockEntries,
    debugEvents: debugEntries.map((e) => e.event),
  };
  writeResult(name, payload);
  const pass =
    mockEntries.filter((e) => e.event === "copilot:spawn").length === 1 &&
    !debugEntries.some((e) => String(e.event).includes("continuation")) &&
    String(agentError?.error?.message ?? "").includes(
      "copilot returned no agent message",
    );
  scenarios.push({
    name: "Copilot empty turn stays on the existing failure path with no continuation",
    result: pass ? "pass" : "fail",
    live: true,
    evidence: writeResult(name, payload),
    reason: pass
      ? "Copilot spawned once and failed immediately without a continuation"
      : `spawns=${mockEntries.length} error=${agentError?.error?.message}`,
  });
}

async function runAcpEmptyThenRecover() {
  const name = "acp-empty-then-recover";
  const cwd = createRepo();
  const mockLogPath = freshLog(name);
  const mockCommand = `${nodeBin} ${join(mocksDir, "acp-empty.mjs")}`;
  const home = createHome(
    [
      "preventSleep: false",
      "acpRegistryOverrides:",
      `  empty-target: ${JSON.stringify(mockCommand)}`,
      "",
    ].join("\n"),
  );
  const result = await runCli(
    cwd,
    [
      "recover the empty acp turn",
      "--agent",
      "acp:empty-target",
      "--max-iterations",
      "1",
      "--prevent-sleep",
      "off",
    ],
    baseEnv(home, {
      GNHF_MOCK_ACP_LOG_PATH: mockLogPath,
      GNHF_MOCK_ACP_MODE: "empty-then-recover",
    }),
  );
  const debugLogPath = findRunLogPath(cwd);
  const debugEntries = readJsonLines(debugLogPath);
  const mockEntries = readJsonLines(mockLogPath);
  const commitCount = git(["rev-list", "--count", "HEAD"], cwd);
  const continuation = debugEntries.find(
    (e) => e.event === "acp:output:continuation",
  );
  const iterationEnd = debugEntries.find((e) => e.event === "iteration:end");
  const prompts = mockEntries.filter((e) => e.event === "agent:prompt:start");
  const payload = {
    name,
    cwd,
    debugLogPath,
    mockLogPath,
    code: result.code,
    stdout: result.stdout,
    stderr: result.stderr,
    commitCount,
    continuation,
    iterationEnd,
    prompts,
    debugEvents: debugEntries.map((e) => e.event),
    mockEvents: mockEntries.map((e) => e.event),
  };
  writeResult(name, payload);
  const pass =
    result.code === 0 &&
    commitCount === "2" &&
    continuation?.attempt === 1 &&
    iterationEnd?.success === true &&
    prompts.length === 2 &&
    prompts[1].isContinuation === true;
  scenarios.push({
    name: "ACP empty first turn recovers via one same-session continuation and commits",
    result: pass ? "pass" : "fail",
    live: true,
    evidence: writeResult(name, payload),
    reason: pass
      ? "ACP recovered after one continuation and committed the iteration"
      : `code=${result.code} commits=${commitCount} continuation=${Boolean(continuation)} prompts=${prompts.length} stderr=${result.stderr.slice(0, 400)}`,
  });
}

async function runAcpStillEmpty() {
  const name = "acp-still-empty";
  const cwd = createRepo();
  const mockLogPath = freshLog(name);
  const mockCommand = `${nodeBin} ${join(mocksDir, "acp-empty.mjs")}`;
  const home = createHome(
    [
      "preventSleep: false",
      "acpRegistryOverrides:",
      `  empty-target: ${JSON.stringify(mockCommand)}`,
      "",
    ].join("\n"),
  );
  const result = await runCli(
    cwd,
    [
      "acp empty twice should fail once",
      "--agent",
      "acp:empty-target",
      "--max-iterations",
      "1",
      "--prevent-sleep",
      "off",
    ],
    baseEnv(home, {
      GNHF_MOCK_ACP_LOG_PATH: mockLogPath,
      GNHF_MOCK_ACP_MODE: "always-empty",
    }),
  );
  const debugLogPath = findRunLogPath(cwd);
  const debugEntries = readJsonLines(debugLogPath);
  const mockEntries = readJsonLines(mockLogPath);
  const commitCount = git(["rev-list", "--count", "HEAD"], cwd);
  const continuation = debugEntries.find(
    (e) => e.event === "acp:output:continuation",
  );
  const agentError = debugEntries.find((e) => e.event === "agent:run:error");
  const prompts = mockEntries.filter((e) => e.event === "agent:prompt:start");
  const payload = {
    name,
    cwd,
    debugLogPath,
    mockLogPath,
    code: result.code,
    stdout: result.stdout,
    stderr: result.stderr,
    commitCount,
    continuation,
    agentError,
    prompts,
    debugEvents: debugEntries.map((e) => e.event),
  };
  writeResult(name, payload);
  const pass =
    commitCount === "1" &&
    continuation?.attempt === 1 &&
    prompts.length === 2 &&
    String(agentError?.error?.message ?? "").includes(
      "ACP agent returned no output text",
    );
  scenarios.push({
    name: "ACP still-empty continuation records the original failure after one retry",
    result: pass ? "pass" : "fail",
    live: true,
    evidence: writeResult(name, payload),
    reason: pass
      ? "Exactly one ACP continuation then the original empty-output failure"
      : `commits=${commitCount} prompts=${prompts.length} error=${agentError?.error?.message}`,
  });
}

async function runHelpHasNoKeepFailedWorkFlag() {
  const name = "cli-help-no-keep-failed-work";
  const result = await runCli(process.cwd(), ["--help"], process.env);
  const help = `${result.stdout}\n${result.stderr}`;
  const payload = {
    name,
    code: result.code,
    stdout: result.stdout,
  };
  writeResult(name, payload);
  const forbidden = /keep[- ]failed|preserve[- ]fail|no-rollback|keep-work/i.test(
    help,
  );
  scenarios.push({
    name: "CLI help does not expose a flag to keep failed-iteration work instead of rolling it back",
    result: !forbidden && result.code === 0 ? "pass" : "fail",
    live: true,
    evidence: writeResult(name, payload),
    reason: !forbidden
      ? "No keep-failed-work flag is advertised on the live CLI help surface"
      : "Help text advertised a keep-failed-work style flag",
  });
}

async function main() {
  await runHelpHasNoKeepFailedWorkFlag();
  await runEmptyThenRecoverOpenCode();
  await runAlwaysEmptyOpenCode();
  await runProviderErrorOpenCode();
  await runInterruptDuringContinuation();
  await runCopilotDoesNotContinue();
  await runAcpEmptyThenRecover();
  await runAcpStillEmpty();
  writeResult("scenarios", { scenarios });
  console.log(JSON.stringify({ scenarios }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
