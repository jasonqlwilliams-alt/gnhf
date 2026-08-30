import { execFileSync, spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RunInfo } from "./run.js";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  type MkdirSync = typeof actual.mkdirSync;
  const synchronizedMkdirSync = ((
    path: Parameters<MkdirSync>[0],
    options?: Parameters<MkdirSync>[1],
  ) => {
    const workerId = process.env.GNHF_ARCHIVE_WORKER_ID;
    const barrierDir = process.env.GNHF_ARCHIVE_BARRIER_DIR;
    const runsDir = process.env.GNHF_ARCHIVE_RUNS_DIR;
    if (
      workerId &&
      barrierDir &&
      runsDir &&
      resolve(String(path)) === resolve(runsDir) &&
      typeof options === "object" &&
      options?.recursive === true
    ) {
      const markerPath = join(barrierDir, workerId);
      if (!actual.existsSync(markerPath)) {
        actual.writeFileSync(markerPath, "", { flag: "wx" });
      }
      const deadline = Date.now() + 10_000;
      while (actual.readdirSync(barrierDir).length < 2) {
        if (Date.now() >= deadline) {
          throw new Error("Timed out waiting for concurrent archive worker");
        }
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      }
    }
    return Reflect.apply(actual.mkdirSync, undefined, [path, options]);
  }) as MkdirSync;
  type RenameSync = typeof actual.renameSync;
  const synchronizedRenameSync = ((
    oldPath: Parameters<RenameSync>[0],
    newPath: Parameters<RenameSync>[1],
  ) => {
    const readyPath = process.env.GNHF_ARCHIVE_PUBLISH_READY;
    const releasePath = process.env.GNHF_ARCHIVE_PUBLISH_RELEASE;
    if (readyPath && releasePath && !actual.existsSync(readyPath)) {
      actual.writeFileSync(readyPath, String(newPath), "utf-8");
      const deadline = Date.now() + 10_000;
      while (!actual.existsSync(releasePath)) {
        if (Date.now() >= deadline) {
          throw new Error("Timed out waiting to publish staged archive");
        }
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      }
    }
    return actual.renameSync(oldPath, newPath);
  }) as RenameSync;
  return {
    ...actual,
    mkdirSync: synchronizedMkdirSync,
    renameSync: synchronizedRenameSync,
  };
});

import { archiveRun, resumeRunIfAvailable, setupRunWithSuffix } from "./run.js";

interface ArchiveWorkerPayload {
  kind: "archive";
  repoRoot: string;
  resultPath: string;
  runInfo: RunInfo;
}

interface CurrentWorkerPayload {
  kind: "current";
  prompt: string;
  repoRoot: string;
  resultPath: string;
  runId: string;
}

type WorkerPayload = ArchiveWorkerPayload | CurrentWorkerPayload;

interface ProcessResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

const workerPayloadPath = process.env.GNHF_ARCHIVE_WORKER_PAYLOAD;
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const testFilePath = fileURLToPath(import.meta.url);
const vitestPath = join(projectRoot, "node_modules", "vitest", "vitest.mjs");
const tempDirs: string[] = [];

function createSourceRun(
  root: string,
  runId: string,
  sourceId: string,
): RunInfo {
  const runDir = join(root, sourceId);
  mkdirSync(runDir, { recursive: true });
  const files = new Map([
    ["base-commit", `base-${sourceId}\n`],
    ["commit-message", "default\n"],
    ["gnhf.log", `${JSON.stringify({ event: "source", sourceId })}\n`],
    [
      "notes.md",
      `# gnhf run: ${runId}\n\nObjective: see .gnhf/runs/${runId}/prompt.md\n\n## Iteration Log\n`,
    ],
    ["output-schema.json", `${JSON.stringify({ sourceId })}\n`],
    ["prompt.md", `prompt-${sourceId}`],
  ]);
  for (const [name, contents] of files) {
    writeFileSync(join(runDir, name), contents, "utf-8");
  }
  return {
    runId,
    runDir,
    promptPath: join(runDir, "prompt.md"),
    notesPath: join(runDir, "notes.md"),
    schemaPath: join(runDir, "output-schema.json"),
    logPath: join(runDir, "gnhf.log"),
    baseCommit: `base-${sourceId}`,
    baseCommitPath: join(runDir, "base-commit"),
    stopWhenPath: join(runDir, "stop-when"),
    stopWhen: undefined,
    commitMessagePath: join(runDir, "commit-message"),
    commitMessage: undefined,
  };
}

function runWorker(
  workerId: string,
  payloadPath: string,
  workerEnv: NodeJS.ProcessEnv = {},
): Promise<ProcessResult> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(
      process.execPath,
      [
        vitestPath,
        "run",
        testFilePath,
        "--pool=forks",
        "--maxWorkers=1",
        "--reporter=dot",
      ],
      {
        cwd: projectRoot,
        env: {
          ...process.env,
          ...workerEnv,
          GNHF_ARCHIVE_WORKER_ID: workerId,
          GNHF_ARCHIVE_WORKER_PAYLOAD: payloadPath,
          NO_COLOR: "1",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolveResult({ code, stdout, stderr });
    });
  });
}

async function waitForPath(path: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for ${path}`);
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
  }
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("archiveRun concurrent collisions", () => {
  it.skipIf(workerPayloadPath !== undefined)(
    "preserves both complete records under distinct archived run IDs",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "gnhf-archive-race-"));
      tempDirs.push(root);
      const repoRoot = join(root, "repo");
      const runsDir = join(repoRoot, ".gnhf", "runs");
      const barrierDir = join(root, "barrier");
      const resultDir = join(root, "results");
      mkdirSync(join(runsDir, "concurrent-archive"), { recursive: true });
      mkdirSync(barrierDir, { recursive: true });
      mkdirSync(resultDir, { recursive: true });
      writeFileSync(
        join(runsDir, "concurrent-archive", "existing.txt"),
        "existing\n",
        "utf-8",
      );

      const workers = ["alpha", "beta"].map((sourceId) => {
        const resultPath = join(resultDir, `${sourceId}.json`);
        const payloadPath = join(root, `${sourceId}.json`);
        const payload: ArchiveWorkerPayload = {
          kind: "archive",
          repoRoot,
          resultPath,
          runInfo: createSourceRun(
            join(root, "sources"),
            "concurrent-archive",
            sourceId,
          ),
        };
        writeFileSync(payloadPath, JSON.stringify(payload), "utf-8");
        return { sourceId, resultPath, payloadPath };
      });

      const processResults = await Promise.all(
        workers.map(({ sourceId, payloadPath }) =>
          runWorker(sourceId, payloadPath, {
            GNHF_ARCHIVE_BARRIER_DIR: barrierDir,
            GNHF_ARCHIVE_RUNS_DIR: runsDir,
          }),
        ),
      );
      for (const result of processResults) {
        expect(result.code, result.stdout + result.stderr).toBe(0);
      }

      const archivedRuns = workers.map(
        ({ resultPath }) =>
          JSON.parse(readFileSync(resultPath, "utf-8")) as RunInfo,
      );
      expect(archivedRuns.map(({ runId }) => runId).sort()).toEqual([
        "concurrent-archive-1",
        "concurrent-archive-2",
      ]);
      expect(readdirSync(runsDir).sort()).toEqual([
        "concurrent-archive",
        "concurrent-archive-1",
        "concurrent-archive-2",
      ]);
      expect(
        readFileSync(
          join(runsDir, "concurrent-archive", "existing.txt"),
          "utf-8",
        ),
      ).toBe("existing\n");

      const prompts = new Set<string>();
      for (const archivedRun of archivedRuns) {
        expect(readdirSync(archivedRun.runDir).sort()).toEqual([
          "base-commit",
          "commit-message",
          "gnhf.log",
          "notes.md",
          "output-schema.json",
          "prompt.md",
        ]);
        prompts.add(readFileSync(archivedRun.promptPath, "utf-8"));
        expect(readFileSync(archivedRun.notesPath, "utf-8")).toContain(
          `Objective: see .gnhf/runs/${archivedRun.runId}/prompt.md`,
        );
      }
      expect(prompts).toEqual(new Set(["prompt-alpha", "prompt-beta"]));
    },
    30_000,
  );

  it.skipIf(workerPayloadPath !== undefined)(
    "keeps a concurrent current-branch run distinct from a staged archive",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "gnhf-archive-publish-"));
      tempDirs.push(root);
      const repoRoot = join(root, "repo");
      const runsDir = join(repoRoot, ".gnhf", "runs");
      const resultDir = join(root, "results");
      const publishReadyPath = join(root, "publish-ready");
      const publishReleasePath = join(root, "publish-release");
      mkdirSync(repoRoot, { recursive: true });
      mkdirSync(resultDir, { recursive: true });
      execFileSync("git", ["init", "-b", "main"], {
        cwd: repoRoot,
        stdio: "ignore",
      });

      const runId = "concurrent-current-branch";
      const archiveResultPath = join(resultDir, "archive.json");
      const archivePayloadPath = join(root, "archive.json");
      const archivePayload: ArchiveWorkerPayload = {
        kind: "archive",
        repoRoot,
        resultPath: archiveResultPath,
        runInfo: createSourceRun(join(root, "sources"), runId, "archive"),
      };
      writeFileSync(
        archivePayloadPath,
        JSON.stringify(archivePayload),
        "utf-8",
      );

      const archiveProcess = runWorker("archive", archivePayloadPath, {
        GNHF_ARCHIVE_PUBLISH_READY: publishReadyPath,
        GNHF_ARCHIVE_PUBLISH_RELEASE: publishReleasePath,
      });
      await waitForPath(publishReadyPath);

      const currentResultPath = join(resultDir, "current.json");
      const currentPayloadPath = join(root, "current.json");
      const currentPayload: CurrentWorkerPayload = {
        kind: "current",
        prompt: "prompt-current",
        repoRoot,
        resultPath: currentResultPath,
        runId,
      };
      writeFileSync(
        currentPayloadPath,
        JSON.stringify(currentPayload),
        "utf-8",
      );
      let currentProcess: ProcessResult;
      try {
        currentProcess = await runWorker("current", currentPayloadPath);
      } finally {
        writeFileSync(publishReleasePath, "", "utf-8");
      }
      expect(
        currentProcess.code,
        currentProcess.stdout + currentProcess.stderr,
      ).toBe(0);

      const archiveResult = await archiveProcess;
      expect(
        archiveResult.code,
        archiveResult.stdout + archiveResult.stderr,
      ).toBe(0);

      const archivedRun = JSON.parse(
        readFileSync(archiveResultPath, "utf-8"),
      ) as RunInfo;
      const currentRun = JSON.parse(
        readFileSync(currentResultPath, "utf-8"),
      ) as RunInfo;
      expect([archivedRun.runId, currentRun.runId].sort()).toEqual([
        runId,
        `${runId}-1`,
      ]);
      expect(readdirSync(runsDir).sort()).toEqual([runId, `${runId}-1`]);
      expect(readFileSync(archivedRun.promptPath, "utf-8")).toBe(
        "prompt-archive",
      );
      expect(readFileSync(currentRun.promptPath, "utf-8")).toBe(
        "prompt-current",
      );
      for (const run of [archivedRun, currentRun]) {
        expect(readdirSync(run.runDir).sort()).toEqual([
          "base-commit",
          "commit-message",
          "gnhf.log",
          "notes.md",
          "output-schema.json",
          "prompt.md",
        ]);
        expect(readFileSync(run.notesPath, "utf-8")).toContain(
          `Objective: see .gnhf/runs/${run.runId}/prompt.md`,
        );
      }
    },
    30_000,
  );

  it.skipIf(workerPayloadPath === undefined)(
    "archives one synchronized worker record",
    () => {
      const payload = JSON.parse(
        readFileSync(workerPayloadPath!, "utf-8"),
      ) as WorkerPayload;
      let run: RunInfo;
      if (payload.kind === "archive") {
        run = archiveRun(payload.runInfo, payload.repoRoot);
      } else {
        run =
          resumeRunIfAvailable(payload.runId, payload.repoRoot, {
            includeStopField: false,
          }) ??
          setupRunWithSuffix(
            payload.runId,
            payload.prompt,
            "base-current",
            payload.repoRoot,
            { includeStopField: false },
          );
        writeFileSync(
          run.logPath,
          `${JSON.stringify({ event: "source", sourceId: "current" })}\n`,
          "utf-8",
        );
      }
      writeFileSync(payload.resultPath, JSON.stringify(run), "utf-8");
      expect(existsSync(run.runDir)).toBe(true);
    },
  );
});
