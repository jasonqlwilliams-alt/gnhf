import {
  closeSync,
  existsSync,
  openSync,
  readdirSync,
  readSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { wordWrap } from "../utils/wordwrap.js";

export const NOTES_REVIEW_FILE = "notes.md";
export const DEBUG_LOG_REVIEW_FILE = "gnhf.log";
export const DEFAULT_LOG_REVIEW_MAX_CHARS = 200_000;

const ITERATION_LOG_RE = /^iteration-(\d+)\.jsonl$/;

export interface LogReviewSection {
  name: string;
  body: string;
  truncated: boolean;
}

export interface LoadRunLogReviewOptions {
  maxCharsPerFile?: number;
}

export function listRunLogReviewFiles(runDir: string): string[] {
  if (!existsSync(runDir)) return [];

  let names: string[] = [];
  try {
    names = readdirSync(runDir);
  } catch {
    return [];
  }

  const iterationLogs = names
    .map((name) => {
      const match = name.match(ITERATION_LOG_RE);
      return match ? { name, n: Number(match[1]) } : null;
    })
    .filter((entry): entry is { name: string; n: number } => entry !== null)
    .sort((a, b) => a.n - b.n)
    .map((entry) => entry.name);

  const ordered: string[] = [];
  if (names.includes(NOTES_REVIEW_FILE)) ordered.push(NOTES_REVIEW_FILE);
  ordered.push(...iterationLogs);
  if (names.includes(DEBUG_LOG_REVIEW_FILE)) {
    ordered.push(DEBUG_LOG_REVIEW_FILE);
  }
  return ordered;
}

export function loadRunLogReviewSections(
  runDir: string,
  options: LoadRunLogReviewOptions = {},
): LogReviewSection[] {
  const maxCharsPerFile =
    options.maxCharsPerFile ?? DEFAULT_LOG_REVIEW_MAX_CHARS;
  return listRunLogReviewFiles(runDir).flatMap((name) => {
    const loaded = readReviewFile(join(runDir, name), maxCharsPerFile);
    if (loaded === null) return [];
    return [{ name, ...loaded }];
  });
}

export function formatRunLogReviewLines(
  sections: LogReviewSection[],
  wrapWidth: number,
): string[] {
  if (sections.length === 0) {
    return ["no local notes or agent logs yet"];
  }

  const width = Math.max(1, wrapWidth);
  const lines: string[] = [];
  for (const section of sections) {
    const header =
      section.truncated === true
        ? `--- ${section.name} (truncated) ---`
        : `--- ${section.name} ---`;
    lines.push(header);
    const body = stripReviewText(section.body);
    const wrapped = wordWrap(body, width);
    if (wrapped.length === 0) {
      lines.push("");
    } else {
      lines.push(...wrapped);
    }
  }
  return lines;
}

export function clampLogReviewOffset(
  offset: number,
  totalLines: number,
  viewHeight: number,
): number {
  const height = Math.max(1, viewHeight);
  const maxOffset = Math.max(0, totalLines - height);
  if (!Number.isFinite(offset)) return 0;
  return Math.min(Math.max(0, Math.trunc(offset)), maxOffset);
}

export function visibleLogReviewLines(
  lines: string[],
  offset: number,
  viewHeight: number,
): string[] {
  const height = Math.max(0, viewHeight);
  const start = clampLogReviewOffset(offset, lines.length, Math.max(1, height));
  return lines.slice(start, start + height);
}

function stripReviewText(s: string): string {
  // OSC, CSI (including SGR), other ESC sequences, then leftover C0
  // controls. Newlines stay so wrap can still split paragraphs.
  /* eslint-disable no-control-regex -- strip OSC/CSI/C0 from log text */
  return s
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b./g, "")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "")
    .replace(/\t/g, " ")
    .replace(/\r\n/g, "\n");
  /* eslint-enable no-control-regex */
}

function readReviewFile(
  path: string,
  maxChars: number,
): { body: string; truncated: boolean } | null {
  let size: number;
  try {
    size = statSync(path).size;
  } catch {
    return null;
  }

  if (size <= maxChars) {
    try {
      return {
        body: readFileUtf8(path, 0, size),
        truncated: false,
      };
    } catch {
      return null;
    }
  }

  try {
    const start = size - maxChars;
    const raw = readFileUtf8(path, start, maxChars);
    const newline = raw.indexOf("\n");
    const body = newline >= 0 ? raw.slice(newline + 1) : raw;
    return { body, truncated: true };
  } catch {
    return null;
  }
}

function readFileUtf8(path: string, position: number, length: number): string {
  if (length <= 0) return "";
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(length);
    const bytesRead = readSync(fd, buf, 0, length, position);
    return buf.subarray(0, bytesRead).toString("utf-8");
  } finally {
    closeSync(fd);
  }
}
