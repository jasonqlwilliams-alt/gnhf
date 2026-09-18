import { describe, expect, it } from "vitest";
import {
  decideClaudeToolPermission,
  isHostWideNodeKill,
} from "./host-wide-node-kill.js";

describe("isHostWideNodeKill", () => {
  it.each([
    "Get-Process -Name node -ErrorAction SilentlyContinue | Stop-Process -Force",
    "Get-Process node | Stop-Process -Force",
    "Stop-Process -Name node -Force",
    'Get-Process | Where-Object {$_.Name -match "node"} | Stop-Process -Force',
    "taskkill /IM node.exe",
    "taskkill /F /T /IM node.exe",
    "taskkill /IM npm.exe /T",
    "Stop-Process -Name npm",
    "Get-Process npm | Stop-Process",
    "taskkill /im NODE.EXE",
    'Stop-Process -Name "node"',
    'powershell -Command "Stop-Process -Name node"',
    "wmic process where \"name='node.exe'\" call terminate",
    "pkill node",
    "killall node",
    "cmd /c taskkill /IM node.exe",
    "Get-Process -Name nodejs | Stop-Process",
    "Stop-Process -Name node,npm",
    "Stop-Process -Name chrome,node",
    "gps node | kill",
    "taskkill /IM node.cmd",
    "Get-Process -Name npm | Stop-Process -Force",
  ])("denies %s", (command) => {
    expect(isHostWideNodeKill(command)).toBe(true);
  });

  it.each([
    "taskkill /T /F /PID 5678",
    "taskkill /PID 1234 /F",
    "Stop-Process -Id 1234",
    "Stop-Process -Id 1234 -Force",
    "Get-Process -Id 1234 | Stop-Process",
    "npm test",
    "npm run build",
    "node dist/cli.mjs",
    "Stop-Process -Name chrome",
    "taskkill /IM chrome.exe",
    "Get-Process python | Stop-Process",
    "git status",
    "pnpm test",
    "npx playwright test",
  ])("allows %s", (command) => {
    expect(isHostWideNodeKill(command)).toBe(false);
  });
});

describe("decideClaudeToolPermission", () => {
  it("denies a PowerShell host-wide Node kill", () => {
    const decision = decideClaudeToolPermission("PowerShell", {
      command:
        "Get-Process -Name node -ErrorAction SilentlyContinue | Stop-Process -Force",
    });
    expect(decision).toEqual({
      behavior: "deny",
      message: expect.stringMatching(/host-wide node\/npm/i),
    });
  });

  it("denies a Bash taskkill image-name Node kill", () => {
    const decision = decideClaudeToolPermission("Bash", {
      command: "taskkill /IM node.exe /F /T",
    });
    expect(decision.behavior).toBe("deny");
  });

  it("allows gnhf's PID-scoped Claude child taskkill", () => {
    const input = { command: "taskkill /T /F /PID 5678" };
    expect(decideClaudeToolPermission("Bash", input)).toEqual({
      behavior: "allow",
      updatedInput: input,
    });
  });

  it("allows other tools so unattended runs stay unattended", () => {
    const input = {
      file_path: "src/app.ts",
      old_string: "a",
      new_string: "b",
    };
    expect(decideClaudeToolPermission("Edit", input)).toEqual({
      behavior: "allow",
      updatedInput: input,
    });
  });

  it("allows ordinary npm test cleanup that is not a name-wide kill", () => {
    const input = { command: "npm test" };
    expect(decideClaudeToolPermission("Bash", input)).toEqual({
      behavior: "allow",
      updatedInput: input,
    });
  });
});
