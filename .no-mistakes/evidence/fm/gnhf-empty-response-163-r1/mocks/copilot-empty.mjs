#!/usr/bin/env node

import { appendFileSync } from "node:fs";

const logPath = process.env.GNHF_MOCK_COPILOT_LOG_PATH;
appendFileSync(
  logPath,
  `${JSON.stringify({
    timestamp: new Date().toISOString(),
    pid: process.pid,
    event: "copilot:spawn",
    argv: process.argv.slice(2),
  })}\n`,
  "utf-8",
);

process.stdout.write(
  `${JSON.stringify({
    type: "session.start",
    data: { id: "mock-session" },
  })}\n`,
);
process.exit(0);
