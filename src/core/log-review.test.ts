import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  clampLogReviewOffset,
  formatRunLogReviewLines,
  listRunLogReviewFiles,
  loadRunLogReviewSections,
  visibleLogReviewLines,
} from "./log-review.js";

describe("listRunLogReviewFiles", () => {
  let runDir: string | undefined;

  afterEach(() => {
    if (runDir) rmSync(runDir, { recursive: true, force: true });
    runDir = undefined;
  });

  it("lists notes, iteration logs in numeric order, then gnhf.log", () => {
    runDir = mkdtempSync(join(tmpdir(), "gnhf-log-review-"));
    writeFileSync(join(runDir, "prompt.md"), "ship it\n");
    writeFileSync(join(runDir, "gnhf.log"), '{"event":"end"}\n');
    writeFileSync(join(runDir, "iteration-10.jsonl"), "{}\n");
    writeFileSync(join(runDir, "iteration-2.jsonl"), "{}\n");
    writeFileSync(join(runDir, "notes.md"), "todo\n");

    expect(listRunLogReviewFiles(runDir)).toEqual([
      "notes.md",
      "iteration-2.jsonl",
      "iteration-10.jsonl",
      "gnhf.log",
    ]);
  });

  it("skips missing review files and ignores unrelated names", () => {
    runDir = mkdtempSync(join(tmpdir(), "gnhf-log-review-"));
    writeFileSync(join(runDir, "iteration-1.jsonl"), "{}\n");
    writeFileSync(join(runDir, "end-state.json"), "{}\n");

    expect(listRunLogReviewFiles(runDir)).toEqual(["iteration-1.jsonl"]);
  });
});

describe("loadRunLogReviewSections", () => {
  let runDir: string | undefined;

  afterEach(() => {
    if (runDir) rmSync(runDir, { recursive: true, force: true });
    runDir = undefined;
  });

  it("loads existing local notes and logs without embedding the run directory path", () => {
    runDir = mkdtempSync(join(tmpdir(), "gnhf-log-review-"));
    writeFileSync(
      join(runDir, "notes.md"),
      "### Iteration 1\n\n**Summary:** added tests\n",
    );
    writeFileSync(
      join(runDir, "iteration-1.jsonl"),
      '{"type":"assistant","text":"reading files"}\n',
    );
    writeFileSync(join(runDir, "gnhf.log"), '{"event":"orchestrator:end"}\n');

    const sections = loadRunLogReviewSections(runDir);
    const combined = sections
      .map((section) => `${section.name}\n${section.body}`)
      .join("\n");

    expect(sections.map((section) => section.name)).toEqual([
      "notes.md",
      "iteration-1.jsonl",
      "gnhf.log",
    ]);
    expect(combined).toContain("added tests");
    expect(combined).toContain("reading files");
    expect(combined).toContain("orchestrator:end");
    expect(combined).not.toContain(runDir);
  });

  it("returns no sections when the run directory has no review files", () => {
    runDir = mkdtempSync(join(tmpdir(), "gnhf-log-review-"));
    expect(loadRunLogReviewSections(runDir)).toEqual([]);
  });

  it("keeps the tail of a large file instead of the truncated head", () => {
    runDir = mkdtempSync(join(tmpdir(), "gnhf-log-review-"));
    writeFileSync(
      join(runDir, "gnhf.log"),
      `${"HEAD_MARKER\n"}${"x".repeat(80)}\nTAIL_MARKER\n`,
    );

    const [section] = loadRunLogReviewSections(runDir, { maxCharsPerFile: 40 });
    expect(section?.name).toBe("gnhf.log");
    expect(section?.body).toContain("TAIL_MARKER");
    expect(section?.body).not.toContain("HEAD_MARKER");
    expect(section?.truncated).toBe(true);
  });
});

describe("formatRunLogReviewLines", () => {
  it("wraps section bodies and labels them with the local file name", () => {
    const lines = formatRunLogReviewLines(
      [
        {
          name: "notes.md",
          body: "alpha beta gamma delta",
          truncated: false,
        },
      ],
      10,
    );

    expect(lines[0]).toBe("--- notes.md ---");
    expect(lines.slice(1).join(" ")).toContain("alpha");
    expect(lines.slice(1).join(" ")).toContain("delta");
    expect(lines.slice(1).every((line) => line.length <= 10)).toBe(true);
  });

  it("marks a truncated file and shows a placeholder when nothing is on disk", () => {
    expect(
      formatRunLogReviewLines(
        [{ name: "gnhf.log", body: "tail", truncated: true }],
        40,
      ),
    ).toEqual(["--- gnhf.log (truncated) ---", "tail"]);

    expect(formatRunLogReviewLines([], 40)).toEqual([
      "no local notes or agent logs yet",
    ]);
  });

  it("strips control sequences so review lines stay printable", () => {
    const lines = formatRunLogReviewLines(
      [
        {
          name: "iteration-1.jsonl",
          body: "\x1b[31mred\x1b[0m text",
          truncated: false,
        },
      ],
      40,
    );

    expect(lines.join("\n")).toContain("red text");
    expect(lines.join("\n")).not.toContain("\x1b[");
  });
});

describe("visibleLogReviewLines", () => {
  const lines = ["a", "b", "c", "d", "e"];

  it("clamps the window to the available lines", () => {
    expect(clampLogReviewOffset(-3, lines.length, 2)).toBe(0);
    expect(clampLogReviewOffset(99, lines.length, 2)).toBe(3);
    expect(visibleLogReviewLines(lines, 0, 2)).toEqual(["a", "b"]);
    expect(visibleLogReviewLines(lines, 3, 2)).toEqual(["d", "e"]);
    expect(visibleLogReviewLines(lines, 99, 2)).toEqual(["d", "e"]);
  });
});
