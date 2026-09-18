import { Readable, Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  CLAUDE_PERMISSION_MCP_TOOL_NAME,
  CLAUDE_PERMISSION_PROMPT_TOOL,
  encodeMcpMessage,
  handleClaudePermissionMcpRequest,
  runClaudePermissionPromptMcp,
} from "./claude-permission-prompt.js";

describe("handleClaudePermissionMcpRequest", () => {
  it("advertises the permission prompt tool on initialize", () => {
    const response = handleClaudePermissionMcpRequest({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2024-11-05" },
    });
    expect(response).toMatchObject({
      jsonrpc: "2.0",
      id: 1,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "gnhf_permissions" },
      },
    });
  });

  it("ignores initialized notifications", () => {
    expect(
      handleClaudePermissionMcpRequest({
        jsonrpc: "2.0",
        method: "notifications/initialized",
      }),
    ).toBeNull();
  });

  it("lists the permission prompt tool", () => {
    const response = handleClaudePermissionMcpRequest({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
    });
    expect(response).toMatchObject({
      id: 2,
      result: {
        tools: [
          {
            name: CLAUDE_PERMISSION_MCP_TOOL_NAME,
            inputSchema: { type: "object" },
          },
        ],
      },
    });
  });

  it("auto-denies a host-wide Node kill and auto-allows other tools", () => {
    const deny = handleClaudePermissionMcpRequest({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: CLAUDE_PERMISSION_MCP_TOOL_NAME,
        arguments: {
          tool_name: "PowerShell",
          input: {
            command: "Stop-Process -Name node -Force",
          },
        },
      },
    });
    expect(deny).toMatchObject({ id: 3 });
    const denyPayload = JSON.parse(
      (deny as { result: { content: { text: string }[] } }).result.content[0]!
        .text,
    );
    expect(denyPayload.behavior).toBe("deny");

    const allow = handleClaudePermissionMcpRequest({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: {
        name: CLAUDE_PERMISSION_MCP_TOOL_NAME,
        arguments: {
          tool_name: "Edit",
          input: { file_path: "src/app.ts" },
        },
      },
    });
    const allowPayload = JSON.parse(
      (allow as { result: { content: { text: string }[] } }).result.content[0]!
        .text,
    );
    expect(allowPayload).toEqual({
      behavior: "allow",
      updatedInput: { file_path: "src/app.ts" },
    });
  });
});

describe("encodeMcpMessage", () => {
  it("frames JSON-RPC with a byte Content-Length header", () => {
    const message = { jsonrpc: "2.0", id: 1, result: { ok: true } };
    const encoded = encodeMcpMessage(message);
    const json = JSON.stringify(message);
    expect(encoded.toString("utf8")).toBe(
      `Content-Length: ${Buffer.byteLength(json, "utf8")}\r\n\r\n${json}`,
    );
  });
});

describe("runClaudePermissionPromptMcp", () => {
  it("answers an initialize request over stdio", async () => {
    const json = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2024-11-05" },
    });
    const stdin = Readable.from([
      Buffer.from(
        `Content-Length: ${Buffer.byteLength(json, "utf8")}\r\n\r\n${json}`,
      ),
    ]);
    const chunks: Buffer[] = [];
    const stdout = new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(Buffer.from(chunk));
        callback();
      },
    });

    await runClaudePermissionPromptMcp({ stdin, stdout });

    const output = Buffer.concat(chunks).toString("utf8");
    expect(output).toContain(CLAUDE_PERMISSION_PROMPT_TOOL.split("__")[1]!);
    expect(output).toContain('"protocolVersion":"2024-11-05"');
  });
});
