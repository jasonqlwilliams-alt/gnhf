import { EventEmitter } from "node:events";
import { describe, it, expect, vi } from "vitest";
import * as renderer from "./renderer.js";
import {
  Renderer,
  stripAnsi,
  renderTitle,
  renderStats,
  renderAgentMessage,
  renderMoonStrip,
  renderStarFieldLines,
  buildFrame,
  buildFrameCells,
  buildContentCells,
  generateSideMeteorShower,
} from "./renderer.js";
import { rowToString } from "./renderer-diff.js";
import { getMoonPhase } from "./utils/moon.js";
import type {
  IterationRecord,
  Orchestrator,
  OrchestratorState,
} from "./core/orchestrator.js";

function createIteration(
  overrides: Partial<IterationRecord> = {},
): IterationRecord {
  return {
    number: 1,
    success: true,
    summary: "done",
    keyChanges: [],
    keyLearnings: [],
    timestamp: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

describe("renderTitle", () => {
  it("renders the gnhf eyebrow above the ASCII art", () => {
    const lines = renderTitle().map(stripAnsi);
    const eyebrowIdx = lines.findIndex((l) => l.includes("g n h f"));
    const artIdx = lines.findIndex((l) => l.includes("┏━╸┏━┓"));
    expect(eyebrowIdx).toBeGreaterThanOrEqual(0);
    expect(artIdx).toBeGreaterThan(eyebrowIdx);
  });

  it("renders the agent name in the eyebrow", () => {
    const lines = renderTitle("rovodev").map(stripAnsi);
    expect(lines[0]).toContain("g n h f");
    expect(lines[0]).toContain("·");
    expect(lines[0]).toContain("r o v o d e v");
  });

  it("renders an acp:<target> spec as two dot-separated segments", () => {
    const lines = renderTitle("acp:claude").map(stripAnsi);
    expect(lines[0]).toContain("g n h f  ·  a c p  ·  c l a u d e");
    // The colon should not appear as a letter-spaced character.
    expect(lines[0]).not.toContain("a c p :");
  });

  it("renders all three lines of ASCII art", () => {
    const plain = renderTitle().map(stripAnsi).join("\n");
    expect(plain).toContain("┏━╸┏━┓┏━┓╺┳┓");
    expect(plain).toContain("┃╺┓┃ ┃┃ ┃ ┃┃");
    expect(plain).toContain("┗━┛┗━┛┗━┛╺┻┛");
  });
});

describe("renderStats", () => {
  it("renders elapsed, total tokens, input tokens, output tokens, and commits", () => {
    const line = stripAnsi(renderStats("01:23:45", 12400, 8200, 12));
    expect(line).toContain("01:23:45");
    expect(line).toContain("21K total");
    expect(line).toContain("12K");
    expect(line).toContain("8K");
    expect(line).toContain("12 commits");
  });

  it("does not contain iteration", () => {
    const line = stripAnsi(renderStats("00:00:00", 0, 0, 0));
    expect(line).not.toContain("iteration");
  });

  it("prefixes token counts with '~' when usage is estimated", () => {
    const plain = stripAnsi(renderStats("01:23:45", 12400, 8200, 12, true));
    expect(plain).toContain("~21K total");
    expect(plain).toContain("~12K in");
    expect(plain).toContain("~8K out");
    // The '~' prefix is informational only - commit count is concrete and
    // should not be prefixed.
    expect(plain).not.toContain("~12 commits");
  });

  it("does not prefix tokens when usage is authoritative", () => {
    const plain = stripAnsi(renderStats("01:23:45", 12400, 8200, 12, false));
    expect(plain).not.toContain("~");
  });

  it("includes cache tokens in the total count", () => {
    const plain = stripAnsi(renderStats("00:00:10", 2, 3, 1, false, 40, 30));
    expect(plain).toContain("75 total");
    expect(plain).toContain("2 in");
    expect(plain).toContain("3 out");
  });

  it("keeps high-token stats rows within the content width", () => {
    const plain = stripAnsi(renderStats("08:07:17", 87_300_000, 860_000, 11));

    expect(plain).toBe(
      "08:07:17 · 88.2M total · 87.3M in · 860K out · 11 commits",
    );
    expect(plain.length).toBeLessThanOrEqual(63);
  });
});

describe("renderAgentMessage", () => {
  it("shows working indicator when no message", () => {
    const plain = renderAgentMessage(null, "running").map(stripAnsi).join("\n");
    expect(plain).toContain("working...");
  });

  it("shows waiting status during backoff", () => {
    const plain = renderAgentMessage(null, "waiting").map(stripAnsi).join("\n");
    expect(plain).toContain("waiting");
  });

  it("shows the last agent error while waiting during backoff", () => {
    const plain = renderAgentMessage(
      "previous agent output",
      "waiting",
      "claude exited with code 1: Credit balance is too low",
    )
      .map(stripAnsi)
      .join("\n");

    expect(plain).toContain("waiting");
    expect(plain).toContain("Credit balance is too low");
    expect(plain).not.toContain("previous agent output");
  });

  it("shows the abort reason and last agent error after abort", () => {
    const plain = renderAgentMessage(
      "3 consecutive failures",
      "aborted",
      "claude exited with code 1: Credit balance is too low",
    )
      .map(stripAnsi)
      .join("\n");

    expect(plain).toContain("3 consecutive failures");
    expect(plain).toContain("Credit balance is too low");
  });

  it("renders a short message on one line", () => {
    const plain = renderAgentMessage("Reading file...", "running")
      .map(stripAnsi)
      .join("\n");
    expect(plain).toContain("Reading file...");
  });

  it("truncates messages longer than 3 lines with ellipsis", () => {
    const longMsg =
      "Line one of the message\nLine two of the message\nLine three of the message\nLine four should be cut";
    const plain = renderAgentMessage(longMsg, "running")
      .map(stripAnsi)
      .join("\n");
    expect(plain).toContain("Line one");
    expect(plain).toContain("Line two");
    expect(plain).toContain("\u2026");
    expect(plain).not.toContain("Line four");
  });

  it("keeps a trailing wide glyph intact at the message width boundary", () => {
    expect(
      renderAgentMessage(`${"A".repeat(62)}🌕`, "running")
        .map(stripAnsi)
        .filter(Boolean),
    ).toEqual(["A".repeat(62), "🌕"]);
  });

  it("strips CSI and other control sequences from lastMessage before wrap", () => {
    const message = `${"\x1b[2J".repeat(50)}reading files\x1b[10;1H\x1b[A\rstuck line`;
    const raw = renderAgentMessage(message, "running").join("\n");
    const plain = renderAgentMessage(message, "running")
      .map(stripAnsi)
      .join("\n");

    expect(raw).not.toContain("\x1b[2J");
    expect(raw).not.toContain("\x1b[10;1H");
    expect(raw).not.toContain("\x1b[A");
    expect(raw).not.toContain("\r");
    expect(plain).toContain("reading files");
    expect(plain).toContain("stuck line");
    expect(plain).not.toContain("\u2026");
  });
});

describe("renderMoonStrip", () => {
  it("renders full moons for successes and new moons for failures", () => {
    const iterations = [
      { success: true },
      { success: true },
      { success: false },
    ];
    const text = renderMoonStrip(iterations, false, Date.now()).join("");
    expect(text).toContain("\u{1F315}\u{1F315}\u{1F311}");
  });

  it("shows an animated moon when running", () => {
    const iterations = [{ success: true }];
    const text = renderMoonStrip(iterations, true, Date.now()).join("");
    expect(text).toContain("\u{1F315}");
    expect(text).toMatch(
      /[\u{1F311}\u{1F312}\u{1F313}\u{1F314}\u{1F315}\u{1F316}\u{1F317}\u{1F318}]/u,
    );
  });

  it("renders empty when no iterations and not running", () => {
    const text = renderMoonStrip([], false, Date.now()).join("");
    expect(text.trim()).toBe("");
  });

  it("shows only active moon when running with no completed iterations", () => {
    const text = renderMoonStrip([], true, Date.now()).join("");
    expect(text).toMatch(
      /[\u{1F311}\u{1F312}\u{1F313}\u{1F314}\u{1F315}\u{1F316}\u{1F317}\u{1F318}]/u,
    );
  });

  it("reflows the active moon onto a later row instead of clipping it on a narrow width", () => {
    const now = 400;
    const activeMoon = getMoonPhase("active", now, 1600);
    const strip = renderMoonStrip(
      Array.from({ length: 24 }, () => ({ success: true })),
      true,
      now,
      20,
    );

    expect(strip).toHaveLength(3);
    expect(strip.at(-1)).toContain(activeMoon);
    expect(strip[0]).not.toContain(activeMoon);
    for (const row of strip) {
      const moonCount = [...row.matchAll(/[\u{1F311}-\u{1F318}]/gu)].length;
      expect(moonCount).toBeLessThanOrEqual(10);
    }
  });
});

describe("renderStarFieldLines", () => {
  it("renders the correct number of rows", () => {
    const lines = renderStarFieldLines(42, 40, 3, Date.now());
    expect(lines).toHaveLength(3);
  });

  it("contains star characters", () => {
    const text = renderStarFieldLines(42, 80, 5, Date.now())
      .map(stripAnsi)
      .join("\n");
    expect(/[·✧⋆°]/.test(text)).toBe(true);
  });

  it("adds a sparse meteor streak without overwhelming the star field", () => {
    const text = renderStarFieldLines(42, 80, 8, 0).map(stripAnsi).join("\n");
    const meteorCells = text.match(/╱/g)?.length ?? 0;

    expect(meteorCells).toBeGreaterThan(0);
    expect(meteorCells).toBeLessThanOrEqual(4);
  });

  it("disables meteors when frequency is zero", () => {
    const text = renderStarFieldLines(42, 80, 8, 0, 0)
      .map(stripAnsi)
      .join("\n");

    expect(text).not.toContain("╱");
  });

  it("increases meteor streaks when frequency is raised", () => {
    const countCells = (frequency: number): number =>
      [0, 500, 1000, 1500]
        .map((now) =>
          renderStarFieldLines(42, 80, 8, now, frequency)
            .map(stripAnsi)
            .join("\n"),
        )
        .reduce((total, text) => total + (text.match(/╱/g)?.length ?? 0), 0);
    const quietCells = countCells(1);
    const busyCells = countCells(3);

    expect(busyCells).toBeGreaterThan(quietCells);
  });

  it("makes frequency 5 roughly twice as frequent as frequency 3", () => {
    const countCells = (frequency: number): number =>
      [
        0, 500, 1000, 1500, 2000, 2500, 3000, 3500, 4000, 4500, 5000, 5500,
        6000, 6500, 7000, 7500, 8000,
      ]
        .map((now) =>
          renderStarFieldLines(42, 120, 12, now, frequency)
            .map(stripAnsi)
            .join("\n"),
        )
        .reduce((total, text) => total + (text.match(/╱/g)?.length ?? 0), 0);
    const mediumCells = countCells(3);
    const highCells = countCells(5);

    expect(highCells).toBeGreaterThanOrEqual(mediumCells * 2);
  });

  it("does not render meteor head glyphs", () => {
    const text = renderStarFieldLines(42, 120, 12, 0, 5)
      .map(stripAnsi)
      .join("\n");

    expect(text).not.toContain("✦");
  });
});

describe("buildFrame", () => {
  const stripCursorHome = (frame: string) =>
    frame.startsWith("\x1b[H") ? frame.slice(3) : frame;

  it("wraps a trailing wide prompt glyph onto the next line instead of dropping it", () => {
    const state: OrchestratorState = {
      status: "running",
      gracefulStopRequested: false,
      interruptHint: "resume",
      currentIteration: 1,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCacheReadTokens: 0,
      totalCacheCreationTokens: 0,
      tokensEstimated: false,
      commitCount: 0,
      iterations: [],
      successCount: 0,
      failCount: 0,
      consecutiveFailures: 0,
      consecutiveErrors: 0,
      startTime: new Date("2026-01-01T00:00:00Z"),
      waitingUntil: null,
      lastMessage: null,
    };

    const lines = renderer
      .buildContentLines(
        `${"A".repeat(62)}🌕`,
        "claude",
        state,
        "00:00:00",
        Date.now(),
      )
      .map(stripAnsi);

    expect(lines.slice(8, 11).filter(Boolean)).toEqual(["A".repeat(62), "🌕"]);
  });

  it("shows the stop and resume hint on the second-to-last row with blank bottom padding", () => {
    const state: OrchestratorState = {
      status: "running",
      gracefulStopRequested: false,
      interruptHint: "resume",
      currentIteration: 1,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCacheReadTokens: 0,
      totalCacheCreationTokens: 0,
      tokensEstimated: false,
      commitCount: 0,
      iterations: [],
      successCount: 0,
      failCount: 0,
      consecutiveFailures: 0,
      consecutiveErrors: 0,
      startTime: new Date("2026-01-01T00:00:00Z"),
      waitingUntil: null,
      lastMessage: null,
    };

    const frame = buildFrame(
      "ship it",
      "claude",
      state,
      [],
      [],
      [],
      Date.now(),
      80,
      30,
    );
    const lines = stripCursorHome(frame).split("\n");
    const rawHintLine = lines.at(-2) ?? "";
    const hintLine = stripAnsi(rawHintLine);

    expect(hintLine.trim()).toBe("[ctrl+c to stop, gnhf again to resume]");
    expect(rawHintLine).toContain("\x1b[2m");
    expect(stripAnsi(lines.at(-1) ?? "").trim()).toBe("");

    const leftPad = hintLine.indexOf("[");
    const rightPad = hintLine.length - leftPad - hintLine.trim().length;
    expect(Math.abs(leftPad - rightPad)).toBeLessThanOrEqual(1);
  });

  it("shows the graceful stop hint after ctrl+c is requested once", () => {
    const state: OrchestratorState = {
      status: "running",
      gracefulStopRequested: true,
      interruptHint: "force-stop",
      currentIteration: 1,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCacheReadTokens: 0,
      totalCacheCreationTokens: 0,
      tokensEstimated: false,
      commitCount: 0,
      iterations: [],
      successCount: 0,
      failCount: 0,
      consecutiveFailures: 0,
      consecutiveErrors: 0,
      startTime: new Date("2026-01-01T00:00:00Z"),
      waitingUntil: null,
      lastMessage: null,
    };

    const frame = buildFrame(
      "ship it",
      "claude",
      state,
      [],
      [],
      [],
      Date.now(),
      120,
      30,
    );
    const lines = stripCursorHome(frame).split("\n");

    expect(stripAnsi(lines.at(-2) ?? "").trim()).toBe(
      "[graceful stop requested, ctrl+c again to force stop, gnhf again to resume]",
    );
  });

  it("keeps all moon rows visible on tight terminals by reserving a real footer row", () => {
    const state: OrchestratorState = {
      status: "stopped",
      gracefulStopRequested: false,
      interruptHint: "force-stop",
      currentIteration: 65,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCacheReadTokens: 0,
      totalCacheCreationTokens: 0,
      tokensEstimated: false,
      commitCount: 0,
      iterations: Array.from({ length: 65 }, (_, index) =>
        createIteration({ number: index + 1, success: true }),
      ),
      successCount: 65,
      failCount: 0,
      consecutiveFailures: 0,
      consecutiveErrors: 0,
      startTime: new Date("2026-01-01T00:00:00Z"),
      waitingUntil: null,
      lastMessage: null,
    };

    const frame = buildFrame(
      "ship it",
      "claude",
      state,
      [],
      [],
      [],
      Date.now(),
      80,
      24,
    );
    const lines = stripCursorHome(frame).split("\n");
    const plainLines = lines.map(stripAnsi);
    const moonLines = plainLines.filter((line) => /🌕/.test(line));

    expect(lines).toHaveLength(24);
    expect(moonLines).toHaveLength(3);
    expect(plainLines.at(-2)?.trim()).toBe(
      "[graceful stop requested, ctrl+c again to force stop, gnhf again to resume]",
    );
    expect(plainLines.at(-1)?.trim()).toBe("");
  });

  it("keeps the active moon visible after resizing to a narrow terminal", () => {
    const now = 400;
    const activeMoon = getMoonPhase("active", now, 1600);
    const state: OrchestratorState = {
      status: "running",
      gracefulStopRequested: false,
      interruptHint: "resume",
      currentIteration: 25,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCacheReadTokens: 0,
      totalCacheCreationTokens: 0,
      tokensEstimated: false,
      commitCount: 0,
      iterations: Array.from({ length: 24 }, (_, index) =>
        createIteration({ number: index + 1, success: true }),
      ),
      successCount: 24,
      failCount: 0,
      consecutiveFailures: 0,
      consecutiveErrors: 0,
      startTime: new Date("2026-01-01T00:00:00Z"),
      waitingUntil: null,
      lastMessage: null,
    };

    for (const terminalWidth of [80, 40, 20]) {
      const frame = buildFrameCells(
        "ship it",
        "claude",
        state,
        [],
        [],
        [],
        now,
        terminalWidth,
        40,
      );

      expect(frame.every((row) => row.length === terminalWidth)).toBe(true);
      expect(frame.map(rowToString).map(stripAnsi).join("\n")).toContain(
        activeMoon,
      );
    }
  });

  it("does not let wide agent text push side stars out of position", () => {
    // Use width where (width - CONTENT_WIDTH) is even so sideWidth*2 + 63 = width
    const terminalWidth = 83;
    const terminalHeight = 30;
    // Message that overflows CONTENT_WIDTH only because the trailing glyph is 2 cells wide.
    const longMessage = `${"A".repeat(62)}🌕`;

    const state: OrchestratorState = {
      status: "running",
      gracefulStopRequested: false,
      interruptHint: "resume",
      currentIteration: 1,
      totalInputTokens: 500,
      totalOutputTokens: 300,
      totalCacheReadTokens: 0,
      totalCacheCreationTokens: 0,
      tokensEstimated: false,
      commitCount: 0,
      iterations: [],
      successCount: 0,
      failCount: 0,
      consecutiveFailures: 0,
      consecutiveErrors: 0,
      startTime: new Date("2026-01-01T00:00:00Z"),
      waitingUntil: null,
      lastMessage: longMessage,
    };

    const cells = buildFrameCells(
      "ship it",
      "claude",
      state,
      [],
      [],
      [],
      Date.now(),
      terminalWidth,
      terminalHeight,
    );

    // Every row must be exactly terminalWidth — a wider agent message row
    // would push the right-side stars out of alignment.
    for (let r = 0; r < cells.length; r++) {
      expect(cells[r]).toHaveLength(terminalWidth);
    }
  });

  it("keeps stats visible when moon rows exceed the content viewport", () => {
    const state: OrchestratorState = {
      status: "stopped",
      gracefulStopRequested: false,
      interruptHint: "force-stop",
      currentIteration: 660,
      totalInputTokens: 1200,
      totalOutputTokens: 800,
      totalCacheReadTokens: 0,
      totalCacheCreationTokens: 0,
      tokensEstimated: false,
      commitCount: 7,
      iterations: Array.from({ length: 660 }, (_, index) =>
        createIteration({ number: index + 1, success: true }),
      ),
      successCount: 660,
      failCount: 0,
      consecutiveFailures: 0,
      consecutiveErrors: 0,
      startTime: new Date("2026-01-01T00:00:00Z"),
      waitingUntil: null,
      lastMessage: null,
    };

    const frame = buildFrame(
      "ship it",
      "claude",
      state,
      [],
      [],
      [],
      Date.now(),
      80,
      24,
    );
    const plainLines = stripCursorHome(frame).split("\n").map(stripAnsi);

    expect(plainLines.join("\n")).toContain("7 commits");
    expect(plainLines.join("\n")).toContain("1K in");
    expect(plainLines.join("\n")).toContain("800 out");
  });

  it("uses the content builder height policy for the content viewport", () => {
    const state: OrchestratorState = {
      status: "running",
      gracefulStopRequested: false,
      interruptHint: "resume",
      currentIteration: 1,
      totalInputTokens: 100,
      totalOutputTokens: 50,
      totalCacheReadTokens: 0,
      totalCacheCreationTokens: 0,
      tokensEstimated: false,
      commitCount: 1,
      iterations: [createIteration()],
      successCount: 1,
      failCount: 0,
      consecutiveFailures: 0,
      consecutiveErrors: 0,
      startTime: new Date("2026-01-01T00:00:00Z"),
      waitingUntil: null,
      lastMessage: "reading files",
    };

    const availableHeight = 22;
    const now = state.startTime.getTime() + 60_000;
    const contentRows = buildContentCells(
      "my prompt",
      "claude",
      state,
      "00:01:00",
      now,
      availableHeight,
    )
      .map(rowToString)
      .map(stripAnsi);
    const frame = buildFrame(
      "my prompt",
      "claude",
      state,
      [],
      [],
      [],
      now,
      63,
      availableHeight + 2,
    );
    const frameLines = stripCursorHome(frame).split("\n").map(stripAnsi);

    expect(
      frameLines.slice(0, availableHeight).map((line) => line.trim()),
    ).toEqual(contentRows);
  });

  it("renders quiet meteor streaks in background rows without changing row widths", () => {
    const state: OrchestratorState = {
      status: "running",
      gracefulStopRequested: false,
      interruptHint: "resume",
      currentIteration: 1,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCacheReadTokens: 0,
      totalCacheCreationTokens: 0,
      tokensEstimated: false,
      commitCount: 0,
      iterations: [],
      successCount: 0,
      failCount: 0,
      consecutiveFailures: 0,
      consecutiveErrors: 0,
      startTime: new Date("2026-01-01T00:00:00Z"),
      waitingUntil: null,
      lastMessage: null,
    };
    const meteors = [
      {
        x: 10,
        y: 3,
        length: 4,
        period: 10_000,
        duration: 1_000,
        phase: 0,
      },
    ];

    const cells = buildFrameCells(
      "ship it",
      "claude",
      state,
      [],
      [],
      [],
      0,
      83,
      36,
      meteors,
      [],
      [],
    );
    const text = cells.map(rowToString).map(stripAnsi).join("\n");
    const meteorCells = text.match(/╱/g)?.length ?? 0;

    expect(meteorCells).toBe(4);
    for (const row of cells) {
      expect(row).toHaveLength(83);
    }
  });

  it("does not start bottom meteors below the top three quarters of the screen", () => {
    const state: OrchestratorState = {
      status: "running",
      gracefulStopRequested: false,
      interruptHint: "resume",
      currentIteration: 1,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCacheReadTokens: 0,
      totalCacheCreationTokens: 0,
      tokensEstimated: false,
      commitCount: 0,
      iterations: [],
      successCount: 0,
      failCount: 0,
      consecutiveFailures: 0,
      consecutiveErrors: 0,
      startTime: new Date("2026-01-01T00:00:00Z"),
      waitingUntil: null,
      lastMessage: null,
    };
    const bottomMeteors = [
      {
        x: 10,
        y: 2,
        length: 3,
        period: 10_000,
        duration: 1_000,
        phase: 0,
      },
    ];

    const cells = buildFrameCells(
      "ship it",
      "claude",
      state,
      [],
      [],
      [],
      0,
      83,
      40,
      [],
      bottomMeteors,
      [],
    );
    const text = cells.map(rowToString).map(stripAnsi).join("\n");

    expect(text).not.toContain("╱");
  });
});

describe("renderer module exports", () => {
  it("does not expose clampCellsToWidth", () => {
    expect("clampCellsToWidth" in renderer).toBe(false);
  });
});

describe("buildContentCells adaptive height", () => {
  const state: OrchestratorState = {
    status: "running",
    gracefulStopRequested: false,
    interruptHint: "resume",
    currentIteration: 1,
    totalInputTokens: 100,
    totalOutputTokens: 50,
    totalCacheReadTokens: 0,
    totalCacheCreationTokens: 0,
    tokensEstimated: false,
    commitCount: 1,
    iterations: [createIteration()],
    successCount: 1,
    failCount: 0,
    consecutiveFailures: 0,
    consecutiveErrors: 0,
    startTime: new Date("2026-01-01T00:00:00Z"),
    waitingUntil: null,
    lastMessage: "reading files",
  };

  const toText = (rows: ReturnType<typeof buildContentCells>): string =>
    rows.map(rowToString).map(stripAnsi).join("\n");

  it("includes all sections at full height", () => {
    const rows = buildContentCells("my prompt", "claude", state, "00:01:00", 0);
    const text = toText(rows);
    expect(text).toContain("┏━╸┏━┓");
    expect(text).toContain("g n h f");
    expect(text).toContain("my prompt");
    expect(text).toContain("reading files");
    expect(text).toContain("00:01:00");
    expect(rows).toHaveLength(22);
  });

  it("keeps the logo separated from both the eyebrow and prompt", () => {
    const lines = buildContentCells("my prompt", "claude", state, "00:01:00", 0)
      .map(rowToString)
      .map(stripAnsi);

    const eyebrowIndex = lines.findIndex((line) => line.includes("g n h f"));
    const firstArtIndex = lines.findIndex((line) => line.includes("┏━╸┏━┓"));
    const lastArtIndex = lines.findIndex((line) => line.includes("┗━┛┗━┛"));
    const promptIndex = lines.findIndex((line) => line.includes("my prompt"));

    expect(firstArtIndex - eyebrowIndex).toBe(3);
    expect(promptIndex - lastArtIndex).toBe(2);
  });

  it("hides ASCII art first when height is insufficient", () => {
    const rows = buildContentCells(
      "my prompt",
      "claude",
      state,
      "00:01:00",
      0,
      21,
    );
    const text = toText(rows);
    expect(text).not.toContain("┏━╸┏━┓");
    expect(text).toContain("g n h f");
    expect(text).toContain("my prompt");
    expect(text).toContain("reading files");
    expect(rows.length).toBeLessThanOrEqual(21);
  });

  it("hides eyebrow after ASCII art", () => {
    const rows = buildContentCells(
      "my prompt",
      "claude",
      state,
      "00:01:00",
      0,
      17,
    );
    const text = toText(rows);
    expect(text).not.toContain("┏━╸┏━┓");
    expect(text).not.toContain("g n h f");
    expect(text).toContain("my prompt");
    expect(text).toContain("reading files");
    expect(rows.length).toBeLessThanOrEqual(17);
  });

  it("hides agent text after eyebrow", () => {
    const rows = buildContentCells(
      "my prompt",
      "claude",
      state,
      "00:01:00",
      0,
      14,
    );
    const text = toText(rows);
    expect(text).not.toContain("┏━╸┏━┓");
    expect(text).not.toContain("g n h f");
    expect(text).not.toContain("reading files");
    expect(text).toContain("my prompt");
    expect(text).toContain("00:01:00");
    expect(rows.length).toBeLessThanOrEqual(14);
  });

  it("hides prompt text last", () => {
    const rows = buildContentCells(
      "my prompt",
      "claude",
      state,
      "00:01:00",
      0,
      9,
    );
    const text = toText(rows);
    expect(text).not.toContain("┏━╸┏━┓");
    expect(text).not.toContain("g n h f");
    expect(text).not.toContain("reading files");
    expect(text).not.toContain("my prompt");
    expect(text).toContain("00:01:00");
    expect(rows.length).toBeLessThanOrEqual(9);
  });

  it("always keeps stats and moon strip even at minimum height", () => {
    const rows = buildContentCells(
      "my prompt",
      "claude",
      state,
      "00:01:00",
      0,
      5,
    );
    const text = toText(rows);
    expect(text).toContain("00:01:00");
    expect(text).toMatch(/🌕/);
    expect(rows.length).toBeLessThanOrEqual(5);
  });

  it("keeps stats visible when moon rows alone exceed the available height", () => {
    const rows = buildContentCells(
      "my prompt",
      "claude",
      {
        ...state,
        status: "stopped",
        iterations: Array.from({ length: 660 }, (_, index) =>
          createIteration({ number: index + 1, success: true }),
        ),
      },
      "00:01:00",
      0,
      22,
    );
    const text = toText(rows);

    expect(text).toContain("00:01:00");
    expect(rows.length).toBeLessThanOrEqual(22);
  });

  it("keeps the newest wrapped moon row when height cannot fit the full strip", () => {
    const now = 400;
    const activeMoon = getMoonPhase("active", now, 1600);
    const rows = buildContentCells(
      "my prompt",
      "claude",
      {
        ...state,
        iterations: Array.from({ length: 50 }, (_, index) =>
          createIteration({ number: index + 1, success: true }),
        ),
      },
      "00:01:00",
      now,
      2,
      20,
    );
    const moonRows = rows.filter((row) =>
      /[\u{1F311}-\u{1F318}]/u.test(rowToString(row)),
    );

    expect(moonRows).toHaveLength(1);
    const moonCount = [
      ...rowToString(moonRows[0]).matchAll(/[\u{1F311}-\u{1F318}]/gu),
    ].length;
    expect(moonCount).toBeLessThanOrEqual(10);
    expect(rowToString(moonRows[0])).toContain(activeMoon);
  });

  it("drops all moon rows when no moon rows fit", () => {
    const rows = buildContentCells(
      "my prompt",
      "claude",
      {
        ...state,
        status: "stopped",
        iterations: Array.from({ length: 660 }, (_, index) =>
          createIteration({ number: index + 1, success: true }),
        ),
      },
      "00:01:00",
      0,
      1,
    );
    const text = toText(rows);

    expect(rows).toHaveLength(1);
    expect(text).toContain("00:01:00");
    expect(text).not.toMatch(/🌕/);
  });
});

describe("Renderer ctrl+c", () => {
  async function runRendererCtrlCTest(state: OrchestratorState): Promise<{
    onInterrupt: ReturnType<typeof vi.fn>;
    orchestratorStop: ReturnType<typeof vi.fn>;
    pause: typeof process.stdin.pause;
    renderer: Renderer;
  }> {
    vi.useFakeTimers();
    let dataHandler: ((data: Buffer) => void) | null = null;
    const onInterrupt = vi.fn();
    const orchestratorStop = vi.fn();
    const orchestrator = Object.assign(new EventEmitter(), {
      getState: vi.fn(() => state),
      stop: orchestratorStop,
      requestGracefulStop: vi.fn(),
    }) as unknown as Orchestrator;

    const originalIsTTY = process.stdin.isTTY;
    const originalSetRawMode = (
      process.stdin as NodeJS.ReadStream & {
        setRawMode?: (mode: boolean) => void;
      }
    ).setRawMode;
    const originalResume = process.stdin.resume;
    const originalPause = process.stdin.pause;
    const originalOn = process.stdin.on;
    const originalRemoveAllListeners = process.stdin.removeAllListeners;
    const stdoutWrite = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);

    Object.defineProperty(process.stdin, "isTTY", {
      configurable: true,
      value: true,
    });
    const setRawModeMock = vi.fn((mode: boolean) => {
      void mode;
      return process.stdin;
    });
    Object.defineProperty(process.stdin, "setRawMode", {
      configurable: true,
      value: setRawModeMock,
    });
    process.stdin.resume = vi.fn();
    process.stdin.pause = vi.fn();
    process.stdin.on = vi.fn(
      (event: string, handler: (...args: unknown[]) => void) => {
        if (event === "data") {
          dataHandler = handler as (data: Buffer) => void;
        }
        return process.stdin;
      },
    ) as typeof process.stdin.on;
    process.stdin.removeAllListeners = vi.fn(() => process.stdin);

    const renderer = new Renderer(
      orchestrator,
      "ship it",
      "claude",
      onInterrupt,
    );

    try {
      renderer.start();

      expect(dataHandler).not.toBeNull();
      if (!dataHandler) {
        throw new Error("expected renderer to register a data handler");
      }
      (dataHandler as unknown as (data: Buffer) => void)(Buffer.from([3]));

      return {
        onInterrupt,
        orchestratorStop,
        pause: process.stdin.pause,
        renderer,
      };
    } finally {
      Object.defineProperty(process.stdin, "isTTY", {
        configurable: true,
        value: originalIsTTY,
      });
      Object.defineProperty(process.stdin, "setRawMode", {
        configurable: true,
        value: originalSetRawMode,
      });
      process.stdin.resume = originalResume;
      process.stdin.pause = originalPause;
      process.stdin.on = originalOn;
      process.stdin.removeAllListeners = originalRemoveAllListeners;
      stdoutWrite.mockRestore();
      vi.useRealTimers();
    }
  }

  it("delegates ctrl+c handling to the callback", async () => {
    const state: OrchestratorState = {
      status: "running",
      gracefulStopRequested: false,
      interruptHint: "resume",
      currentIteration: 1,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCacheReadTokens: 0,
      totalCacheCreationTokens: 0,
      tokensEstimated: false,
      commitCount: 0,
      iterations: [],
      successCount: 0,
      failCount: 0,
      consecutiveFailures: 0,
      consecutiveErrors: 0,
      startTime: new Date("2026-01-01T00:00:00Z"),
      waitingUntil: null,
      lastMessage: null,
    };

    const { onInterrupt, orchestratorStop, pause } =
      await runRendererCtrlCTest(state);

    expect(onInterrupt).toHaveBeenCalledTimes(1);
    expect(orchestratorStop).not.toHaveBeenCalled();
    expect(pause).not.toHaveBeenCalled();
  });
});

describe("Renderer ctrl+l", () => {
  const TICK_MS = 200;

  function hasFullEraseThenRedraw(output: string): boolean {
    const esc = "\u001b";
    const eraseAt = [
      output.indexOf(`${esc}[2J${esc}[H`),
      output.indexOf(`${esc}[H${esc}[J`),
      output.indexOf(`${esc}[H${esc}[0J`),
      output.indexOf(`${esc}[J${esc}[H`),
      output.indexOf(`${esc}[0J${esc}[H`),
    ].filter((idx) => idx >= 0);
    if (eraseAt.length === 0) return false;
    return /[A-Za-z]/.test(output.slice(Math.min(...eraseAt)));
  }

  it("erases and redraws the frame on ctrl+l without interrupting the run", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    let dataHandler: ((data: Buffer) => void) | null = null;
    const onInterrupt = vi.fn();
    const state: OrchestratorState = {
      status: "running",
      gracefulStopRequested: false,
      interruptHint: "resume",
      currentIteration: 1,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCacheReadTokens: 0,
      totalCacheCreationTokens: 0,
      tokensEstimated: false,
      commitCount: 0,
      iterations: [],
      successCount: 0,
      failCount: 0,
      consecutiveFailures: 0,
      consecutiveErrors: 0,
      startTime: new Date(0),
      waitingUntil: null,
      lastMessage: "reading files",
    };
    const orchestrator = Object.assign(new EventEmitter(), {
      getState: vi.fn(() => state),
      stop: vi.fn(),
    }) as unknown as Orchestrator;

    const originalIsTTY = process.stdin.isTTY;
    const originalSetRawMode = (
      process.stdin as NodeJS.ReadStream & {
        setRawMode?: (mode: boolean) => void;
      }
    ).setRawMode;
    const originalResume = process.stdin.resume;
    const originalPause = process.stdin.pause;
    const originalOn = process.stdin.on;
    const originalRemoveAllListeners = process.stdin.removeAllListeners;
    const originalColumns = Object.getOwnPropertyDescriptor(
      process.stdout,
      "columns",
    );
    const originalRows = Object.getOwnPropertyDescriptor(
      process.stdout,
      "rows",
    );
    const stdoutWrite = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);

    Object.defineProperty(process.stdin, "isTTY", {
      configurable: true,
      value: true,
    });
    Object.defineProperty(process.stdin, "setRawMode", {
      configurable: true,
      value: vi.fn(() => process.stdin),
    });
    process.stdin.resume = vi.fn();
    process.stdin.pause = vi.fn();
    process.stdin.on = vi.fn(
      (event: string, handler: (...args: unknown[]) => void) => {
        if (event === "data") {
          dataHandler = handler as (data: Buffer) => void;
        }
        return process.stdin;
      },
    ) as typeof process.stdin.on;
    process.stdin.removeAllListeners = vi.fn(() => process.stdin);
    Object.defineProperty(process.stdout, "columns", {
      configurable: true,
      value: 80,
    });
    Object.defineProperty(process.stdout, "rows", {
      configurable: true,
      value: 24,
    });

    const renderer = new Renderer(
      orchestrator,
      "ship it",
      "claude",
      onInterrupt,
    );

    try {
      renderer.start();
      expect(dataHandler).not.toBeNull();
      if (!dataHandler) {
        throw new Error("expected renderer to register a data handler");
      }

      stdoutWrite.mockClear();
      (dataHandler as unknown as (data: Buffer) => void)(Buffer.from([12]));
      const refreshOutput = stdoutWrite.mock.calls
        .map((args: unknown[]) => String(args[0]))
        .join("");

      expect(hasFullEraseThenRedraw(refreshOutput)).toBe(true);
      expect(stripAnsi(refreshOutput)).toContain("ship it");
      expect(stripAnsi(refreshOutput)).toContain("reading files");
      expect(onInterrupt).not.toHaveBeenCalled();

      stdoutWrite.mockClear();
      vi.advanceTimersByTime(TICK_MS);
      const nextTick = stdoutWrite.mock.calls
        .map((args: unknown[]) => String(args[0]))
        .join("");
      expect(hasFullEraseThenRedraw(nextTick)).toBe(false);
    } finally {
      renderer.stop();
      Object.defineProperty(process.stdin, "isTTY", {
        configurable: true,
        value: originalIsTTY,
      });
      Object.defineProperty(process.stdin, "setRawMode", {
        configurable: true,
        value: originalSetRawMode,
      });
      process.stdin.resume = originalResume;
      process.stdin.pause = originalPause;
      process.stdin.on = originalOn;
      process.stdin.removeAllListeners = originalRemoveAllListeners;
      if (originalRows)
        Object.defineProperty(process.stdout, "rows", originalRows);
      if (originalColumns)
        Object.defineProperty(process.stdout, "columns", originalColumns);
      stdoutWrite.mockRestore();
      vi.useRealTimers();
    }
  });
});

describe("Renderer meteors", () => {
  function renderContentSideText(
    meteorFrequency: number,
    terminalHeight = 46,
  ): string {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const state: OrchestratorState = {
      status: "running",
      gracefulStopRequested: false,
      interruptHint: "resume",
      currentIteration: 1,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCacheReadTokens: 0,
      totalCacheCreationTokens: 0,
      tokensEstimated: false,
      commitCount: 0,
      iterations: [],
      successCount: 0,
      failCount: 0,
      consecutiveFailures: 0,
      consecutiveErrors: 0,
      startTime: new Date(0),
      waitingUntil: null,
      lastMessage: null,
    };
    const orchestrator = Object.assign(new EventEmitter(), {
      getState: vi.fn(() => state),
      stop: vi.fn(),
    }) as unknown as Orchestrator;
    const stdoutWrite = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    const random = vi.spyOn(Math, "random").mockReturnValue(0);
    const originalStdinTty = Object.getOwnPropertyDescriptor(
      process.stdin,
      "isTTY",
    );
    const originalColumns = Object.getOwnPropertyDescriptor(
      process.stdout,
      "columns",
    );
    const originalRows = Object.getOwnPropertyDescriptor(
      process.stdout,
      "rows",
    );
    Object.defineProperty(process.stdin, "isTTY", {
      configurable: true,
      value: false,
    });
    Object.defineProperty(process.stdout, "columns", {
      configurable: true,
      value: 121,
    });
    Object.defineProperty(process.stdout, "rows", {
      configurable: true,
      value: terminalHeight,
    });

    try {
      const renderer = new Renderer(
        orchestrator,
        "ship it",
        "claude",
        vi.fn(),
        {
          meteorFrequency,
        },
      );
      renderer.start();
      renderer.stop();

      const output = stdoutWrite.mock.calls
        .map((args: unknown[]) => String(args[0]))
        .join("");
      const frame = output.startsWith("\x1b[H") ? output.slice(3) : output;
      const lines = frame.split("\n").map(stripAnsi);
      const sideWidth = Math.floor((121 - 63) / 2);
      const availableHeight = terminalHeight - 2;
      const contentRows = buildContentCells(
        "ship it",
        "claude",
        state,
        "0s",
        0,
        availableHeight,
      );
      while (contentRows.length < Math.min(24, availableHeight)) {
        contentRows.push([]);
      }
      const topHeight = Math.ceil((availableHeight - contentRows.length) / 2);
      const contentSideText = lines
        .slice(topHeight, topHeight + contentRows.length)
        .map((line) => `${line.slice(0, sideWidth)}${line.slice(-sideWidth)}`)
        .join("\n");

      return contentSideText;
    } finally {
      if (originalRows)
        Object.defineProperty(process.stdout, "rows", originalRows);
      if (originalColumns)
        Object.defineProperty(process.stdout, "columns", originalColumns);
      if (originalStdinTty)
        Object.defineProperty(process.stdin, "isTTY", originalStdinTty);
      random.mockRestore();
      stdoutWrite.mockRestore();
      vi.useRealTimers();
    }
  }

  it("renders meteors beside the main content area", () => {
    expect(renderContentSideText(5)).toContain("╱");
  });

  it("keeps low-frequency side meteors visible on tall terminals", () => {
    expect(renderContentSideText(1, 100)).toContain("╱");
  });

  it("honors the lowest side meteor frequency count", () => {
    const meteors = generateSideMeteorShower(121, 29, 44, 1, 102);

    expect(meteors).toHaveLength(1);
  });
});

describe("Renderer terminal title", () => {
  const escape = String.fromCharCode(27);
  const bell = String.fromCharCode(7);
  const titlePrefix = `${escape}]2;`;
  const titleStackPrefix = `${escape}[`;
  const titleStackSuffix = ";0t";

  function setTty(
    target: NodeJS.WriteStream | NodeJS.ReadStream,
    value: boolean,
  ) {
    const original = Object.getOwnPropertyDescriptor(target, "isTTY");
    Object.defineProperty(target, "isTTY", {
      configurable: true,
      value,
    });
    return () => {
      if (original) {
        Object.defineProperty(target, "isTTY", original);
      }
    };
  }

  function extractTerminalTitles(
    stdoutWrite: ReturnType<typeof vi.spyOn>,
  ): string[] {
    const output = stdoutWrite.mock.calls
      .map((args: unknown[]) => String(args[0]))
      .join("");
    return output
      .split(titlePrefix)
      .slice(1)
      .map((segment: string) => segment.split(bell, 1)[0] ?? "");
  }

  function extractTitleStackOps(
    stdoutWrite: ReturnType<typeof vi.spyOn>,
  ): string[] {
    const output = stdoutWrite.mock.calls
      .map((args: unknown[]) => String(args[0]))
      .join("");
    return output
      .split(titleStackPrefix)
      .slice(1)
      .map((segment: string) => segment.split(titleStackSuffix, 1)[0] ?? "")
      .filter((segment: string) => segment === "22" || segment === "23");
  }

  const baseState: OrchestratorState = {
    status: "running",
    gracefulStopRequested: false,
    interruptHint: "resume",
    currentIteration: 1,
    totalInputTokens: 12_400,
    totalOutputTokens: 8_200,
    totalCacheReadTokens: 0,
    totalCacheCreationTokens: 0,
    tokensEstimated: false,
    commitCount: 12,
    iterations: [createIteration()],
    successCount: 1,
    failCount: 0,
    consecutiveFailures: 0,
    consecutiveErrors: 0,
    startTime: new Date("2026-01-01T00:00:00Z"),
    waitingUntil: null,
    lastMessage: "reading files",
  };

  it("writes a running title with the active moon and counters", () => {
    const state = { ...baseState, iterations: [...baseState.iterations] };
    const orchestrator = Object.assign(new EventEmitter(), {
      getState: vi.fn(() => state),
      stop: vi.fn(),
    }) as unknown as Orchestrator;
    const stdoutWrite = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    const restoreStdinTty = setTty(process.stdin, false);
    const restoreStdoutTty = setTty(process.stdout, true);

    try {
      const renderer = new Renderer(orchestrator, "ship it", "claude", vi.fn());
      renderer.start();

      const titles = extractTerminalTitles(stdoutWrite);
      expect(titles.at(-1)).toMatch(
        /^gnhf [🌑🌒🌓🌔🌕🌖🌗🌘] · 21K total · 12K in · 8K out · 12 commits$/u,
      );

      renderer.stop();
    } finally {
      restoreStdoutTty();
      restoreStdinTty();
      stdoutWrite.mockRestore();
    }
  });

  it("does not emit title control codes when stdout is not a tty", () => {
    const state = { ...baseState, iterations: [...baseState.iterations] };
    const orchestrator = Object.assign(new EventEmitter(), {
      getState: vi.fn(() => state),
      stop: vi.fn(),
    }) as unknown as Orchestrator;
    const stdoutWrite = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    const restoreStdinTty = setTty(process.stdin, false);
    const restoreStdoutTty = setTty(process.stdout, false);

    try {
      const renderer = new Renderer(orchestrator, "ship it", "claude", vi.fn());
      renderer.start();
      renderer.stop();

      expect(extractTerminalTitles(stdoutWrite)).toEqual([]);
      expect(extractTitleStackOps(stdoutWrite)).toEqual([]);
    } finally {
      restoreStdoutTty();
      restoreStdinTty();
      stdoutWrite.mockRestore();
    }
  });

  it("updates the title when the run stops", async () => {
    const state = { ...baseState, iterations: [...baseState.iterations] };
    const orchestrator = Object.assign(new EventEmitter(), {
      getState: vi.fn(() => state),
      stop: vi.fn(),
    }) as unknown as Orchestrator;
    const stdoutWrite = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    const restoreStdinTty = setTty(process.stdin, false);
    const restoreStdoutTty = setTty(process.stdout, true);

    try {
      const renderer = new Renderer(orchestrator, "ship it", "claude", vi.fn());
      renderer.start();
      stdoutWrite.mockClear();

      state.status = "stopped";
      orchestrator.emit("state", {
        ...state,
        iterations: [...state.iterations],
      });
      orchestrator.emit("stopped");

      await expect(renderer.waitUntilExit()).resolves.toBe("stopped");

      const titles = extractTerminalTitles(stdoutWrite);
      const meaningfulTitles = titles.filter((t: string) => t !== "");
      expect(meaningfulTitles.at(-1)).toBe(
        "gnhf stopped · 21K total · 12K in · 8K out · 12 commits",
      );
    } finally {
      restoreStdoutTty();
      restoreStdinTty();
      stdoutWrite.mockRestore();
    }
  });

  it("stops updating the title after the renderer exits", () => {
    const state = { ...baseState, iterations: [...baseState.iterations] };
    const orchestrator = Object.assign(new EventEmitter(), {
      getState: vi.fn(() => state),
      stop: vi.fn(),
    }) as unknown as Orchestrator;
    const stdoutWrite = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    const restoreStdinTty = setTty(process.stdin, false);
    const restoreStdoutTty = setTty(process.stdout, true);

    try {
      const renderer = new Renderer(orchestrator, "ship it", "claude", vi.fn());
      renderer.start();
      renderer.stop("interrupted");
      stdoutWrite.mockClear();

      state.status = "stopped";
      orchestrator.emit("state", {
        ...state,
        iterations: [...state.iterations],
      });

      expect(stdoutWrite).not.toHaveBeenCalled();
    } finally {
      restoreStdoutTty();
      restoreStdinTty();
      stdoutWrite.mockRestore();
    }
  });

  it("restores the previous terminal title when the renderer exits", () => {
    const state = { ...baseState, iterations: [...baseState.iterations] };
    const orchestrator = Object.assign(new EventEmitter(), {
      getState: vi.fn(() => state),
      stop: vi.fn(),
    }) as unknown as Orchestrator;
    const stdoutWrite = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    const restoreStdinTty = setTty(process.stdin, false);
    const restoreStdoutTty = setTty(process.stdout, true);

    try {
      const renderer = new Renderer(orchestrator, "ship it", "claude", vi.fn());
      renderer.start();
      stdoutWrite.mockClear();
      renderer.stop();

      expect(extractTitleStackOps(stdoutWrite)).toEqual(["23"]);
      const titles = extractTerminalTitles(stdoutWrite);
      expect(titles).toContain("");
      const output = stdoutWrite.mock.calls
        .map((args: unknown[]) => String(args[0]))
        .join("");
      const emptyTitleIdx = output.indexOf(`${titlePrefix}${bell}`);
      const restoreIdx = output.indexOf(`${escape}[23${titleStackSuffix}`);
      expect(emptyTitleIdx).toBeGreaterThanOrEqual(0);
      expect(restoreIdx).toBeGreaterThanOrEqual(0);
      expect(emptyTitleIdx).toBeLessThan(restoreIdx);
    } finally {
      restoreStdoutTty();
      restoreStdinTty();
      stdoutWrite.mockRestore();
    }
  });
});

describe("Renderer resize", () => {
  const TICK_MS = 200;
  const LARGE = { columns: 120, rows: 40 };
  const SMALL = { columns: 80, rows: 24 };

  function runningState(): OrchestratorState {
    return {
      status: "running",
      gracefulStopRequested: false,
      interruptHint: "resume",
      currentIteration: 1,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCacheReadTokens: 0,
      totalCacheCreationTokens: 0,
      tokensEstimated: false,
      commitCount: 0,
      iterations: [],
      successCount: 0,
      failCount: 0,
      consecutiveFailures: 0,
      consecutiveErrors: 0,
      startTime: new Date(0),
      waitingUntil: null,
      lastMessage: null,
    };
  }

  function joinedWrites(stdoutWrite: ReturnType<typeof vi.spyOn>): string {
    return stdoutWrite.mock.calls
      .map((args: unknown[]) => String(args[0]))
      .join("");
  }

  function createScreen(rows: number, cols: number, fill: string): string[][] {
    return Array.from({ length: rows }, () =>
      Array.from({ length: cols }, () => fill),
    );
  }

  function applyAnsi(screen: string[][], output: string): void {
    const rows = screen.length;
    const cols = screen[0]?.length ?? 0;
    let r = 0;
    let c = 0;
    let i = 0;

    const eraseFromCursorToEnd = () => {
      if (r >= rows) return;
      for (let x = c; x < cols; x++) screen[r][x] = " ";
      for (let y = r + 1; y < rows; y++) {
        screen[y].fill(" ");
      }
    };

    const eraseDisplay = (mode: number) => {
      if (mode === 2) {
        for (const row of screen) row.fill(" ");
        return;
      }
      if (mode === 1) {
        for (let y = 0; y < r && y < rows; y++) screen[y].fill(" ");
        if (r < rows) {
          for (let x = 0; x <= c && x < cols; x++) screen[r][x] = " ";
        }
        return;
      }
      eraseFromCursorToEnd();
    };

    while (i < output.length) {
      if (output[i] === "\u001b") {
        if (output[i + 1] === "]") {
          const bel = output.indexOf("\u0007", i);
          i = bel === -1 ? output.length : bel + 1;
          continue;
        }
        if (output[i + 1] === "[") {
          const rest = output.slice(i + 2);
          const cmdOffset = rest.search(/[A-Za-z]/);
          if (cmdOffset === -1) break;
          const params = rest.slice(0, cmdOffset);
          const cmd = rest[cmdOffset];
          i += 3 + cmdOffset;
          if (cmd === "H" || cmd === "f") {
            const [rowPart, colPart] = params.split(";");
            r = Math.max(0, (Number(rowPart) || 1) - 1);
            c = Math.max(0, (Number(colPart) || 1) - 1);
          } else if (cmd === "J") {
            eraseDisplay(params === "" ? 0 : Number(params));
          } else if (cmd === "K") {
            if (r >= rows) continue;
            const mode = params === "" ? 0 : Number(params);
            if (mode === 2) screen[r].fill(" ");
            else if (mode === 1) {
              for (let x = 0; x <= c && x < cols; x++) screen[r][x] = " ";
            } else {
              for (let x = c; x < cols; x++) screen[r][x] = " ";
            }
          }
          continue;
        }
        i += 1;
        continue;
      }
      if (output[i] === "\n") {
        r += 1;
        c = 0;
        i += 1;
        continue;
      }
      if (output[i] === "\r") {
        c = 0;
        i += 1;
        continue;
      }
      if (output.charCodeAt(i) < 32) {
        i += 1;
        continue;
      }
      if (r < rows && c < cols) screen[r][c] = output[i];
      c += 1;
      i += 1;
    }
  }

  function cellsOutside(
    screen: string[][],
    rows: number,
    cols: number,
  ): Array<{ row: number; col: number; char: string }> {
    const found: Array<{ row: number; col: number; char: string }> = [];
    for (let row = 0; row < screen.length; row++) {
      for (let col = 0; col < screen[row].length; col++) {
        if (row < rows && col < cols) continue;
        const char = screen[row][col];
        if (char !== " ") found.push({ row, col, char });
      }
    }
    return found;
  }

  function hasFullEraseThenRedraw(output: string): boolean {
    const esc = "\u001b";
    const eraseAt = [
      output.indexOf(`${esc}[2J${esc}[H`),
      output.indexOf(`${esc}[H${esc}[J`),
      output.indexOf(`${esc}[H${esc}[0J`),
      output.indexOf(`${esc}[J${esc}[H`),
      output.indexOf(`${esc}[0J${esc}[H`),
    ].filter((idx) => idx >= 0);
    if (eraseAt.length === 0) return false;
    return /[A-Za-z]/.test(output.slice(Math.min(...eraseAt)));
  }

  function runResizeRenderer(
    body: (args: {
      stdoutWrite: ReturnType<typeof vi.spyOn>;
      setSize: (size: { columns: number; rows: number }) => void;
      tick: () => void;
    }) => void,
  ): void {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const state = runningState();
    const orchestrator = Object.assign(new EventEmitter(), {
      getState: vi.fn(() => state),
      stop: vi.fn(),
    }) as unknown as Orchestrator;
    const stdoutWrite = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    const random = vi.spyOn(Math, "random").mockReturnValue(0);
    const originalStdinTty = Object.getOwnPropertyDescriptor(
      process.stdin,
      "isTTY",
    );
    const originalColumns = Object.getOwnPropertyDescriptor(
      process.stdout,
      "columns",
    );
    const originalRows = Object.getOwnPropertyDescriptor(
      process.stdout,
      "rows",
    );

    const setSize = (size: { columns: number; rows: number }) => {
      Object.defineProperty(process.stdout, "columns", {
        configurable: true,
        value: size.columns,
      });
      Object.defineProperty(process.stdout, "rows", {
        configurable: true,
        value: size.rows,
      });
    };

    Object.defineProperty(process.stdin, "isTTY", {
      configurable: true,
      value: false,
    });
    setSize(LARGE);

    const renderer = new Renderer(orchestrator, "ship it", "claude", vi.fn());

    try {
      renderer.start();
      body({
        stdoutWrite,
        setSize,
        tick: () => {
          vi.advanceTimersByTime(TICK_MS);
        },
      });
      renderer.stop();
    } finally {
      if (originalRows)
        Object.defineProperty(process.stdout, "rows", originalRows);
      if (originalColumns)
        Object.defineProperty(process.stdout, "columns", originalColumns);
      if (originalStdinTty)
        Object.defineProperty(process.stdin, "isTTY", originalStdinTty);
      random.mockRestore();
      stdoutWrite.mockRestore();
      vi.useRealTimers();
    }
  }

  it("erases leftover cells from the previous frame when the terminal shrinks", () => {
    runResizeRenderer(({ stdoutWrite, setSize, tick }) => {
      const screen = createScreen(LARGE.rows, LARGE.columns, " ");
      applyAnsi(screen, joinedWrites(stdoutWrite));
      const leftoverBefore = cellsOutside(screen, SMALL.rows, SMALL.columns);
      expect(leftoverBefore.length).toBeGreaterThan(0);

      stdoutWrite.mockClear();
      setSize(SMALL);
      tick();
      const shrinkOutput = joinedWrites(stdoutWrite);
      applyAnsi(screen, shrinkOutput);

      expect(hasFullEraseThenRedraw(shrinkOutput)).toBe(true);
      expect(cellsOutside(screen, SMALL.rows, SMALL.columns)).toEqual([]);
      expect(stripAnsi(shrinkOutput)).toContain("ship it");
    });
  });

  it("erases leftover cells after shrinking and restoring the original size", () => {
    runResizeRenderer(({ stdoutWrite, setSize, tick }) => {
      const screen = createScreen(LARGE.rows, LARGE.columns, "#");
      applyAnsi(screen, joinedWrites(stdoutWrite));

      stdoutWrite.mockClear();
      setSize(SMALL);
      tick();
      applyAnsi(screen, joinedWrites(stdoutWrite));

      stdoutWrite.mockClear();
      setSize(LARGE);
      tick();
      const restoreOutput = joinedWrites(stdoutWrite);
      applyAnsi(screen, restoreOutput);

      expect(hasFullEraseThenRedraw(restoreOutput)).toBe(true);
      expect(screen.some((row) => row.includes("#"))).toBe(false);
      expect(stripAnsi(restoreOutput)).toContain("ship it");
    });
  });
});
