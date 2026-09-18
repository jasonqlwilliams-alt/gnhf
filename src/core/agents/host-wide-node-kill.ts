const NODE_IMAGE = String.raw`(?:node(?:js)?|npm)(?:\.exe|\.cmd|\.bat)?`;
const NODE_NAME_TOKEN = new RegExp(
  String.raw`(^|[^A-Za-z0-9_])${NODE_IMAGE}(?=[^A-Za-z0-9_]|$)`,
  "i",
);
const NODE_NAME_LIST = new RegExp(
  String.raw`-Name\s+['"]?(?:[^'"\s,]+,)*${NODE_IMAGE}\b`,
  "i",
);
const STOP_CMD = String.raw`(?:Stop-Process|spps|(?<![A-Za-z])kill)`;
const GET_PROCESS_CMD = String.raw`(?:Get-Process|gps)`;

export function isHostWideNodeKill(command: string): boolean {
  const text = command.replace(/\s+/g, " ").trim();
  if (!text) {
    return false;
  }

  if (isPidScopedProcessKill(text) && !hasNodeNameSelector(text)) {
    return false;
  }

  return (
    isStopProcessByNodeName(text) ||
    isGetProcessNodePipeline(text) ||
    isWhereObjectNodePipeline(text) ||
    isTaskkillByNodeImage(text) ||
    isWmicNodeTerminate(text) ||
    isUnixNameWideNodeKill(text)
  );
}

export type ClaudePermissionDecision =
  | { behavior: "allow"; updatedInput: Record<string, unknown> }
  | { behavior: "deny"; message: string };

export function decideClaudeToolPermission(
  _toolName: string,
  input: unknown,
): ClaudePermissionDecision {
  if (collectCommandStrings(input).some(isHostWideNodeKill)) {
    return {
      behavior: "deny",
      message:
        "Refusing a host-wide node/npm process kill. Stop only PIDs this iteration started; killing every Node process also kills gnhf.",
    };
  }

  return {
    behavior: "allow",
    updatedInput: isRecord(input) ? input : {},
  };
}

function isPidScopedProcessKill(text: string): boolean {
  return /(?:\/PID\s+\d+|-(?:Id|PID)\s+\d+)/i.test(text);
}

function hasNodeNameSelector(text: string): boolean {
  return (
    NODE_NAME_LIST.test(text) ||
    new RegExp(String.raw`\/IM\s+['"]?${NODE_IMAGE}\b`, "i").test(text)
  );
}

function isStopProcessByNodeName(text: string): boolean {
  return new RegExp(
    String.raw`${STOP_CMD}\s+[^\n]*${NODE_NAME_LIST.source}`,
    "i",
  ).test(text);
}

function isGetProcessNodePipeline(text: string): boolean {
  const positional = new RegExp(
    String.raw`${GET_PROCESS_CMD}\s+['"]?${NODE_IMAGE}['"]?(?:\s+-\S+(?:\s+\S+)?)?\s*\|\s*${STOP_CMD}`,
    "i",
  );
  const named = new RegExp(
    String.raw`${GET_PROCESS_CMD}\s+[^\n|]*${NODE_NAME_LIST.source}[^\n]*\|\s*${STOP_CMD}`,
    "i",
  );
  return positional.test(text) || named.test(text);
}

function isWhereObjectNodePipeline(text: string): boolean {
  return new RegExp(
    String.raw`${GET_PROCESS_CMD}[^\n]*Where-Object[^\n]*${NODE_IMAGE}[^\n]*\|\s*${STOP_CMD}`,
    "i",
  ).test(text);
}

function isTaskkillByNodeImage(text: string): boolean {
  if (!/\btaskkill\b/i.test(text) || /\/PID\s+\d+/i.test(text)) {
    return false;
  }
  return new RegExp(String.raw`\/IM\s+['"]?${NODE_IMAGE}\b`, "i").test(text);
}

function isWmicNodeTerminate(text: string): boolean {
  return (
    /\bwmic\s+process\s+where\b/i.test(text) &&
    NODE_NAME_TOKEN.test(text) &&
    /(?:call\s+terminate|\bdelete\b)/i.test(text)
  );
}

function isUnixNameWideNodeKill(text: string): boolean {
  return new RegExp(
    String.raw`(?:^|[;&]\s*)(?:pkill|killall)(?:\s+-\S+)*\s+['"]?${NODE_IMAGE}['"]?(?:\s|$)`,
    "i",
  ).test(text);
}

function collectCommandStrings(input: unknown): string[] {
  if (typeof input === "string") {
    return [input];
  }
  if (!isRecord(input)) {
    return [];
  }
  const commands: string[] = [];
  for (const key of ["command", "cmd", "script"]) {
    const value = input[key];
    if (typeof value === "string") {
      commands.push(value);
    }
  }
  return commands;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
