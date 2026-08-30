import {
  closeSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  renameSync,
  writeFileSync,
  appendFileSync,
  readFileSync,
  readdirSync,
  existsSync,
  rmSync,
} from "node:fs";
import { basename, join, dirname, isAbsolute, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import {
  buildAgentOutputSchema,
  type AgentOutputCommitField,
} from "./agents/types.js";
import {
  CONVENTIONAL_COMMIT_MESSAGE,
  getCommitMessageSchemaFields,
  type CommitMessageConfig,
} from "./commit-message.js";
import { findLegacyRunBaseCommit, getHeadCommit } from "./git.js";

export interface RunInfo {
  runId: string;
  runDir: string;
  promptPath: string;
  notesPath: string;
  schemaPath: string;
  logPath: string;
  baseCommit: string;
  baseCommitPath: string;
  stopWhenPath: string;
  stopWhen: string | undefined;
  commitMessagePath: string;
  commitMessage: CommitMessageConfig | undefined;
}

export interface RunMetadata {
  runId: string;
  runDir: string;
  promptPath: string;
  schemaPath: string;
  commitMessagePath: string;
  commitMessage: CommitMessageConfig | undefined;
}

const LOG_FILENAME = "gnhf.log";
const STOP_WHEN_FILENAME = "stop-when";
const COMMIT_MESSAGE_FILENAME = "commit-message";

function runIdWithSuffix(runId: string, suffix: number): string {
  return suffix === 0 ? runId : `${runId}-${suffix}`;
}

function hasErrorCode(error: unknown, ...codes: string[]): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string" &&
    codes.includes(error.code)
  );
}

interface RunIdLock {
  fd: number;
  path: string;
}

function runIdLockPath(runId: string, cwd: string): string {
  return join(cwd, ".gnhf", "runs", `.${runId}.lock`);
}

function runIdReservationPath(runId: string, cwd: string): string {
  return join(cwd, ".gnhf", "runs", `.${runId}.reserved`);
}

function readRunIdReservationOwner(runId: string, cwd: string): string | null {
  const path = runIdReservationPath(runId, cwd);
  if (!existsSync(path)) return null;
  return readFileSync(path, "utf-8").trim();
}

function writeRunIdReservation(
  runId: string,
  cwd: string,
  runDir: string,
): string {
  const path = runIdReservationPath(runId, cwd);
  writeFileSync(path, `${resolve(runDir)}\n`, {
    encoding: "utf-8",
    flag: "wx",
    mode: 0o600,
  });
  return path;
}

function isRunIdReserved(runId: string, cwd: string): boolean {
  return (
    existsSync(join(cwd, ".gnhf", "runs", runId)) ||
    existsSync(runIdReservationPath(runId, cwd))
  );
}

function tryAcquireRunIdLock(runId: string, cwd: string): RunIdLock | null {
  mkdirSync(join(cwd, ".gnhf", "runs"), { recursive: true });
  const path = runIdLockPath(runId, cwd);
  try {
    return { fd: openSync(path, "wx", 0o600), path };
  } catch (error) {
    if (hasErrorCode(error, "EEXIST")) return null;
    throw error;
  }
}

function releaseRunIdLock(lock: RunIdLock): void {
  try {
    closeSync(lock.fd);
  } finally {
    rmSync(lock.path, { force: true });
  }
}

export function createRunIdWithSuffix(runId: string, cwd: string): string {
  for (let suffix = 0; suffix < 100; suffix += 1) {
    const candidate = runIdWithSuffix(runId, suffix);
    if (
      !isRunIdReserved(candidate, cwd) &&
      !existsSync(runIdLockPath(candidate, cwd))
    ) {
      return candidate;
    }
  }
  throw new Error(`Unable to create a unique run id for ${runId}`);
}

function rewriteArchivedNotes(
  notes: string,
  originalRunId: string,
  archivedRunId: string,
): string {
  if (archivedRunId === originalRunId) return notes;
  const notesLines = notes.split("\n");
  if (notesLines[0] === `# gnhf run: ${originalRunId}`) {
    notesLines[0] = `# gnhf run: ${archivedRunId}`;
  }
  if (
    notesLines[2] === `Objective: see .gnhf/runs/${originalRunId}/prompt.md`
  ) {
    notesLines[2] = `Objective: see .gnhf/runs/${archivedRunId}/prompt.md`;
  }
  return notesLines.join("\n");
}

export function archiveRun(runInfo: RunInfo, repoRoot: string): RunInfo {
  const runsDir = join(repoRoot, ".gnhf", "runs");
  mkdirSync(runsDir, { recursive: true });
  const stagingRunDir = mkdtempSync(join(runsDir, ".archive-"));
  const stagingNotesPath = join(stagingRunDir, basename(runInfo.notesPath));
  try {
    cpSync(runInfo.runDir, stagingRunDir, { recursive: true });
    const originalNotes = readFileSync(stagingNotesPath, "utf-8");

    for (let suffix = 0; suffix < 100; suffix += 1) {
      const archivedRunId = runIdWithSuffix(runInfo.runId, suffix);
      const archivedRunDir = join(runsDir, archivedRunId);
      const lock = tryAcquireRunIdLock(archivedRunId, repoRoot);
      if (!lock) continue;
      try {
        const reservationOwner = readRunIdReservationOwner(
          archivedRunId,
          repoRoot,
        );
        const ownsReservation =
          reservationOwner !== null &&
          resolve(reservationOwner) === resolve(runInfo.runDir);
        if (existsSync(archivedRunDir)) {
          if (ownsReservation) {
            throw new Error(
              `Reserved run id ${archivedRunId} already has an archive`,
            );
          }
          continue;
        }
        if (reservationOwner !== null && !ownsReservation) continue;
        writeFileSync(
          stagingNotesPath,
          rewriteArchivedNotes(originalNotes, runInfo.runId, archivedRunId),
          "utf-8",
        );
        try {
          renameSync(stagingRunDir, archivedRunDir);
        } catch (error) {
          if (hasErrorCode(error, "EEXIST", "ENOTEMPTY")) {
            if (ownsReservation) throw error;
            continue;
          }
          throw error;
        }
        if (ownsReservation) {
          rmSync(runIdReservationPath(archivedRunId, repoRoot), {
            force: true,
          });
        }
        const archivedPath = (path: string) =>
          join(archivedRunDir, basename(path));
        return {
          ...runInfo,
          runId: archivedRunId,
          runDir: archivedRunDir,
          promptPath: archivedPath(runInfo.promptPath),
          notesPath: archivedPath(runInfo.notesPath),
          schemaPath: archivedPath(runInfo.schemaPath),
          logPath: archivedPath(runInfo.logPath),
          baseCommitPath: archivedPath(runInfo.baseCommitPath),
          stopWhenPath: archivedPath(runInfo.stopWhenPath),
          commitMessagePath: archivedPath(runInfo.commitMessagePath),
        };
      } finally {
        releaseRunIdLock(lock);
      }
    }
    throw new Error(`Unable to create a unique run id for ${runInfo.runId}`);
  } finally {
    rmSync(stagingRunDir, { recursive: true, force: true });
  }
}

function writeSchemaFile(
  schemaPath: string,
  schemaOptions: RunSchemaOptions,
): void {
  writeFileSync(
    schemaPath,
    JSON.stringify(
      buildAgentOutputSchema({
        includeStopField: schemaOptions.includeStopField,
        commitFields: schemaOptions.commitFields,
      }),
      null,
      2,
    ),
    "utf-8",
  );
}

export interface RunSchemaOptions {
  includeStopField: boolean;
  commitFields?: AgentOutputCommitField[];
  commitMessage?: CommitMessageConfig;
  stopWhen?: string;
  clearStopWhen?: boolean;
}

function readStopWhen(stopWhenPath: string): string | undefined {
  if (!existsSync(stopWhenPath)) return undefined;
  const stopWhen = readFileSync(stopWhenPath, "utf-8").trim();
  return stopWhen.length > 0 ? stopWhen : undefined;
}

function commitMessageMetadataValue(
  commitMessage: CommitMessageConfig | undefined,
): "default" | "conventional" {
  return commitMessage?.preset ?? "default";
}

function readCommitMessageMetadata(
  commitMessagePath: string,
): CommitMessageConfig | undefined {
  const value = readFileSync(commitMessagePath, "utf-8").trim();
  if (value === "" || value === "default") return undefined;
  if (value === "conventional") return CONVENTIONAL_COMMIT_MESSAGE;
  throw new Error(`Unknown commit message metadata: ${value}`);
}

function inferCommitMessageFromSchema(
  schemaPath: string,
): CommitMessageConfig | undefined {
  if (!existsSync(schemaPath)) return undefined;
  try {
    const schema = JSON.parse(readFileSync(schemaPath, "utf-8")) as {
      properties?: Record<string, unknown>;
    };
    if (
      schema.properties?.type !== undefined &&
      schema.properties.scope !== undefined
    ) {
      return CONVENTIONAL_COMMIT_MESSAGE;
    }
  } catch {
    // Legacy metadata is best-effort; malformed schemas fall back to default.
  }
  return undefined;
}

function resolveRunCommitMessage(
  commitMessagePath: string,
  schemaPath: string,
): CommitMessageConfig | undefined {
  if (existsSync(commitMessagePath)) {
    return readCommitMessageMetadata(commitMessagePath);
  }

  const commitMessage = inferCommitMessageFromSchema(schemaPath);
  writeFileSync(
    commitMessagePath,
    `${commitMessageMetadataValue(commitMessage)}\n`,
    "utf-8",
  );
  return commitMessage;
}

function peekRunCommitMessage(
  commitMessagePath: string,
  schemaPath: string,
): CommitMessageConfig | undefined {
  if (existsSync(commitMessagePath)) {
    return readCommitMessageMetadata(commitMessagePath);
  }

  return inferCommitMessageFromSchema(schemaPath);
}

function writeCommitMessageMetadata(
  commitMessagePath: string,
  commitMessage: CommitMessageConfig | undefined,
): void {
  writeFileSync(
    commitMessagePath,
    `${commitMessageMetadataValue(commitMessage)}\n`,
    "utf-8",
  );
}

function ensureRunMetadataIgnored(cwd: string): void {
  const excludePath = execFileSync(
    "git",
    ["rev-parse", "--git-path", "info/exclude"],
    { cwd, encoding: "utf-8" },
  ).trim();
  const resolved = isAbsolute(excludePath)
    ? excludePath
    : join(cwd, excludePath);
  const entry = ".gnhf/runs/";
  mkdirSync(dirname(resolved), { recursive: true });

  if (existsSync(resolved)) {
    const content = readFileSync(resolved, "utf-8");
    if (content.split("\n").some((line) => line.trim() === entry)) return;
    const separator = content.length > 0 && !content.endsWith("\n") ? "\n" : "";
    appendFileSync(resolved, `${separator}${entry}\n`, "utf-8");
  } else {
    // This ignore rule is runtime metadata, so keep it local to the clone
    // instead of mutating tracked .gitignore state on startup.
    writeFileSync(resolved, `${entry}\n`, "utf-8");
  }
}

export function setupRun(
  runId: string,
  prompt: string,
  baseCommit: string,
  cwd: string,
  schemaOptions: RunSchemaOptions,
): RunInfo {
  ensureRunMetadataIgnored(cwd);

  const runDir = join(cwd, ".gnhf", "runs", runId);
  mkdirSync(runDir, { recursive: true });

  const promptPath = join(runDir, "prompt.md");
  writeFileSync(promptPath, prompt, "utf-8");

  const notesPath = join(runDir, "notes.md");
  if (!existsSync(notesPath)) {
    writeFileSync(
      notesPath,
      `# gnhf run: ${runId}\n\nObjective: see .gnhf/runs/${runId}/prompt.md\n\n## Iteration Log\n`,
      "utf-8",
    );
  }

  const schemaPath = join(runDir, "output-schema.json");
  writeSchemaFile(schemaPath, schemaOptions);

  const logPath = join(runDir, LOG_FILENAME);

  const baseCommitPath = join(runDir, "base-commit");
  const hasStoredBaseCommit = existsSync(baseCommitPath);
  const resolvedBaseCommit = hasStoredBaseCommit
    ? readFileSync(baseCommitPath, "utf-8").trim()
    : baseCommit;
  if (!hasStoredBaseCommit) {
    writeFileSync(baseCommitPath, `${baseCommit}\n`, "utf-8");
  }

  const stopWhenPath = join(runDir, STOP_WHEN_FILENAME);
  const stopWhen = schemaOptions.stopWhen;
  if (stopWhen !== undefined) {
    writeFileSync(stopWhenPath, `${stopWhen}\n`, "utf-8");
  }
  const commitMessagePath = join(runDir, COMMIT_MESSAGE_FILENAME);
  const commitMessage = schemaOptions.commitMessage;
  writeCommitMessageMetadata(commitMessagePath, commitMessage);

  return {
    runId,
    runDir,
    promptPath,
    notesPath,
    schemaPath,
    logPath,
    baseCommit: resolvedBaseCommit,
    baseCommitPath,
    stopWhenPath,
    stopWhen,
    commitMessagePath,
    commitMessage,
  };
}

export function setupRunWithSuffix(
  runId: string,
  prompt: string,
  baseCommit: string,
  cwd: string,
  schemaOptions: RunSchemaOptions,
  prepareCandidate?: (candidateRunId: string) => boolean,
  reservationCwd = cwd,
  candidateCwdForRunId?: (candidateRunId: string) => string,
): RunInfo {
  for (let suffix = 0; suffix < 100; suffix += 1) {
    const candidate = runIdWithSuffix(runId, suffix);
    const candidateCwd = candidateCwdForRunId?.(candidate) ?? cwd;
    const usesSeparateReservation =
      resolve(reservationCwd) !== resolve(candidateCwd);
    const lock = tryAcquireRunIdLock(candidate, reservationCwd);
    if (!lock) continue;
    let reservationPath: string | undefined;
    let keepReservation = false;
    try {
      if (isRunIdReserved(candidate, reservationCwd)) continue;
      if (
        usesSeparateReservation &&
        existsSync(join(candidateCwd, ".gnhf", "runs", candidate))
      ) {
        continue;
      }
      if (usesSeparateReservation) {
        try {
          reservationPath = writeRunIdReservation(
            candidate,
            reservationCwd,
            join(candidateCwd, ".gnhf", "runs", candidate),
          );
        } catch (error) {
          if (hasErrorCode(error, "EEXIST")) continue;
          throw error;
        }
      }
      if (prepareCandidate && !prepareCandidate(candidate)) continue;
      keepReservation = prepareCandidate !== undefined;
      const runInfo = setupRun(
        candidate,
        prompt,
        baseCommit,
        candidateCwd,
        schemaOptions,
      );
      keepReservation = true;
      return runInfo;
    } finally {
      if (reservationPath && !keepReservation) {
        rmSync(reservationPath, { force: true });
      }
      releaseRunIdLock(lock);
    }
  }
  throw new Error(`Unable to create a unique run id for ${runId}`);
}

export function resumeRun(
  runId: string,
  cwd: string,
  schemaOptions: RunSchemaOptions,
): RunInfo {
  const runDir = join(cwd, ".gnhf", "runs", runId);
  if (!existsSync(runDir)) {
    throw new Error(`Run directory not found: ${runDir}`);
  }

  const promptPath = join(runDir, "prompt.md");
  const notesPath = join(runDir, "notes.md");
  const schemaPath = join(runDir, "output-schema.json");
  const logPath = join(runDir, LOG_FILENAME);
  const baseCommitPath = join(runDir, "base-commit");
  const baseCommit = existsSync(baseCommitPath)
    ? readFileSync(baseCommitPath, "utf-8").trim()
    : backfillLegacyBaseCommit(runId, baseCommitPath, cwd);
  const stopWhenPath = join(runDir, STOP_WHEN_FILENAME);
  let stopWhen = readStopWhen(stopWhenPath);
  if (schemaOptions.clearStopWhen) {
    rmSync(stopWhenPath, { force: true });
    stopWhen = undefined;
  } else if (schemaOptions.stopWhen !== undefined) {
    stopWhen = schemaOptions.stopWhen;
    writeFileSync(stopWhenPath, `${stopWhen}\n`, "utf-8");
  }
  const commitMessagePath = join(runDir, COMMIT_MESSAGE_FILENAME);
  const commitMessage = resolveRunCommitMessage(commitMessagePath, schemaPath);
  writeSchemaFile(schemaPath, {
    ...schemaOptions,
    commitMessage,
    commitFields: getCommitMessageSchemaFields(commitMessage),
    includeStopField: schemaOptions.includeStopField || stopWhen !== undefined,
  });

  return {
    runId,
    runDir,
    promptPath,
    notesPath,
    schemaPath,
    logPath,
    baseCommit,
    baseCommitPath,
    stopWhenPath,
    stopWhen,
    commitMessagePath,
    commitMessage,
  };
}

export function resumeRunIfAvailable(
  runId: string,
  cwd: string,
  schemaOptions: RunSchemaOptions,
): RunInfo | null {
  const lock = tryAcquireRunIdLock(runId, cwd);
  if (!lock) return null;
  try {
    if (!existsSync(join(cwd, ".gnhf", "runs", runId))) return null;
    return resumeRun(runId, cwd, schemaOptions);
  } finally {
    releaseRunIdLock(lock);
  }
}

export function peekRunMetadata(runId: string, cwd: string): RunMetadata {
  const runDir = join(cwd, ".gnhf", "runs", runId);
  if (!existsSync(runDir)) {
    throw new Error(`Run directory not found: ${runDir}`);
  }

  const promptPath = join(runDir, "prompt.md");
  const schemaPath = join(runDir, "output-schema.json");
  const commitMessagePath = join(runDir, COMMIT_MESSAGE_FILENAME);
  const commitMessage = peekRunCommitMessage(commitMessagePath, schemaPath);

  return {
    runId,
    runDir,
    promptPath,
    schemaPath,
    commitMessagePath,
    commitMessage,
  };
}

function backfillLegacyBaseCommit(
  runId: string,
  baseCommitPath: string,
  cwd: string,
): string {
  const baseCommit = findLegacyRunBaseCommit(runId, cwd) ?? getHeadCommit(cwd);
  writeFileSync(baseCommitPath, `${baseCommit}\n`, "utf-8");
  return baseCommit;
}

export function getLastIterationNumber(runInfo: RunInfo): number {
  const files = readdirSync(runInfo.runDir);
  let max = 0;
  for (const f of files) {
    const m = f.match(/^iteration-(\d+)\.jsonl$/);
    if (m) {
      const n = parseInt(m[1]!, 10);
      if (n > max) max = n;
    }
  }
  return max;
}

export function toStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((v): v is string => typeof v === "string");
  }
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) {
        return parsed.filter((v): v is string => typeof v === "string");
      }
    } catch {
      // Not JSON — fall through to render raw
    }
    return [value];
  }
  return [];
}

function formatListSection(title: string, items: string[]): string {
  if (items.length === 0) return "";
  return `**${title}:**\n${items.map((item) => `- ${item}`).join("\n")}\n`;
}

export function appendNotes(
  notesPath: string,
  iteration: number,
  summary: string,
  changes: string[],
  learnings: string[],
): void {
  const entry = [
    `\n### Iteration ${iteration}\n`,
    `**Summary:** ${summary}\n`,
    formatListSection("Changes", changes),
    formatListSection("Learnings", learnings),
  ].join("\n");

  appendFileSync(notesPath, entry, "utf-8");
}
