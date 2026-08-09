#!/usr/bin/env node

// Stands in for the `claude` CLI on a failing run. The failure shape is picked
// with GNHF_MOCK_CLAUDE_MODE so one fixture covers every stream combination.

import process from "node:process";

const mode = process.env.GNHF_MOCK_CLAUDE_MODE ?? "stdout-error";

if (mode === "no-output") {
  process.exit(1);
}

if (mode === "stderr-error") {
  process.stderr.write("Invalid API key - please run /login\n");
  process.exit(1);
}

process.stdout.write(
  `${JSON.stringify({
    type: "result",
    subtype: "error_during_execution",
    is_error: true,
    result: "Invalid model name: claude-nonexistent-5",
  })}\n`,
);
process.exit(1);
