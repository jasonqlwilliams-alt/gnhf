import { EventEmitter } from "node:events";
import { Renderer } from "/home/jason/.no-mistakes/worktrees/81d474556c1c/01M2V8MP0QZD9XPSSRPEBN4WSB/src/renderer.ts";

const lastMessage = Array.from(
  { length: 30 },
  (_, index) => `Message line ${index + 1}`,
).join("\n");

const state = {
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
  lastMessage,
};

const orchestrator = Object.assign(new EventEmitter(), {
  getState: () => ({ ...state, iterations: [] }),
  stop() {},
});

process.stdout.write("\x1b[?1049h\x1b[?25l");
const renderer = new Renderer(
  orchestrator,
  "overflow probe",
  "claude",
  () => {
    process.stderr.write("INTERRUPT\n");
  },
  { meteorFrequency: 0 },
);
renderer.start();
