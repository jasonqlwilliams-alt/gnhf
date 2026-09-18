import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { decideClaudeToolPermission } from "./host-wide-node-kill.js";

export const CLAUDE_PERMISSION_PROMPT_FLAG = "--gnhf-claude-permission-prompt";
export const CLAUDE_PERMISSION_MCP_SERVER_NAME = "gnhf_permissions";
export const CLAUDE_PERMISSION_MCP_TOOL_NAME = "permission_prompt";
export const CLAUDE_PERMISSION_PROMPT_TOOL = `mcp__${CLAUDE_PERMISSION_MCP_SERVER_NAME}__${CLAUDE_PERMISSION_MCP_TOOL_NAME}`;

const MCP_PROTOCOL_VERSION = "2024-11-05";

export function buildWindowsClaudePermissionArgs(
  execPath = process.execPath,
  scriptPath = process.argv[1] ?? fileURLToPath(import.meta.url),
): string[] {
  // Resolve against this process cwd. Claude later starts the MCP server
  // with cwd set to the agent working directory, which --worktree moves
  // to a sibling checkout, so a relative argv[1] such as dist/cli.mjs
  // would miss the real CLI. See claude-permission-prompt.test.ts.
  return [
    "--mcp-config",
    JSON.stringify({
      mcpServers: {
        [CLAUDE_PERMISSION_MCP_SERVER_NAME]: {
          command: execPath,
          args: [resolve(scriptPath), CLAUDE_PERMISSION_PROMPT_FLAG],
        },
      },
    }),
    "--permission-prompt-tool",
    CLAUDE_PERMISSION_PROMPT_TOOL,
  ];
}

export function encodeMcpMessage(message: unknown): Buffer {
  const json = JSON.stringify(message);
  return Buffer.from(
    `Content-Length: ${Buffer.byteLength(json, "utf8")}\r\n\r\n${json}`,
    "utf8",
  );
}

export function handleClaudePermissionMcpRequest(
  message: unknown,
): Record<string, unknown> | null {
  if (!isRecord(message)) {
    return null;
  }

  const method = message.method;
  if (typeof method !== "string") {
    return null;
  }
  if (method.startsWith("notifications/")) {
    return null;
  }

  const id = message.id;
  if (id === undefined) {
    return null;
  }

  switch (method) {
    case "initialize": {
      const params = isRecord(message.params) ? message.params : {};
      const protocolVersion =
        typeof params.protocolVersion === "string"
          ? params.protocolVersion
          : MCP_PROTOCOL_VERSION;
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: CLAUDE_PERMISSION_MCP_SERVER_NAME },
        },
      };
    }
    case "ping":
      return { jsonrpc: "2.0", id, result: {} };
    case "tools/list":
      return {
        jsonrpc: "2.0",
        id,
        result: {
          tools: [
            {
              name: CLAUDE_PERMISSION_MCP_TOOL_NAME,
              description:
                "Approve or deny Claude Code tool calls for unattended gnhf runs",
              inputSchema: {
                type: "object",
                properties: {
                  tool_name: { type: "string" },
                  input: { type: "object" },
                  tool_use_id: { type: "string" },
                },
                required: ["tool_name", "input"],
              },
            },
          ],
        },
      };
    case "tools/call":
      return {
        jsonrpc: "2.0",
        id,
        result: {
          content: [
            {
              type: "text",
              text: JSON.stringify(decideFromMcpCall(message.params)),
            },
          ],
        },
      };
    default:
      return {
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: `Method not found: ${method}` },
      };
  }
}

export async function runClaudePermissionPromptMcp(
  stdio: {
    stdin?: NodeJS.ReadableStream;
    stdout?: NodeJS.WritableStream;
  } = {},
): Promise<void> {
  const stdin = stdio.stdin ?? process.stdin;
  const stdout = stdio.stdout ?? process.stdout;
  const framer = new McpStdioFramer();

  for await (const chunk of stdin) {
    for (const parsed of framer.push(Buffer.from(chunk))) {
      const response = handleClaudePermissionMcpRequest(parsed);
      if (response) {
        stdout.write(encodeMcpMessage(response));
      }
    }
  }
}

class McpStdioFramer {
  private buffer = Buffer.alloc(0);

  push(chunk: Buffer): unknown[] {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const messages: unknown[] = [];
    while (true) {
      const message = this.readOne();
      if (message === undefined) {
        break;
      }
      messages.push(message);
    }
    return messages;
  }

  private readOne(): unknown | undefined {
    const headerEnd = this.buffer.indexOf("\r\n\r\n");
    if (headerEnd === -1) {
      return undefined;
    }
    const header = this.buffer.subarray(0, headerEnd).toString("utf8");
    const match = /Content-Length:\s*(\d+)/i.exec(header);
    if (!match) {
      this.buffer = this.buffer.subarray(headerEnd + 4);
      return undefined;
    }
    const length = Number(match[1]);
    const bodyStart = headerEnd + 4;
    if (this.buffer.length < bodyStart + length) {
      return undefined;
    }
    const body = this.buffer.subarray(bodyStart, bodyStart + length);
    this.buffer = this.buffer.subarray(bodyStart + length);
    return JSON.parse(body.toString("utf8"));
  }
}

function decideFromMcpCall(params: unknown) {
  const record = isRecord(params) ? params : {};
  const args = isRecord(record.arguments) ? record.arguments : record;
  const toolName = typeof args.tool_name === "string" ? args.tool_name : "";
  return decideClaudeToolPermission(toolName, args.input);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
