import type { CodexMonitorEvent } from "@codex-monitor/protocol";

interface RawHookEvent {
  hook_event_name?: string;
  eventName?: string;
  event_name?: string;
  name?: string;
  session_id?: string;
  turn_id?: string;
  tool_call_id?: string;
  tool_name?: string;
  tool_input?: unknown;
  tool_response?: unknown;
  prompt?: string;
  message?: string;
  command?: string;
  cwd?: string;
  last_assistant_message?: string;
  timestamp?: string;
}

export function parseHookLine(line: string, hostId: string): CodexMonitorEvent | null {
  const raw = JSON.parse(line) as RawHookEvent;
  const hookEventName = normalizeHookEventName(raw);
  const at = raw.timestamp ?? new Date().toISOString();
  const threadId = raw.session_id ?? "unknown-thread";
  const turnId = raw.turn_id ?? `${threadId}-${at}`;

  if (hookEventName === "sessionstart") {
    return {
      type: "thread.started",
      threadId,
      title: (raw.cwd ?? threadId).slice(0, 80),
      at,
      hostId,
    };
  }

  if (hookEventName === "userpromptsubmit") {
    return {
      type: "turn.started",
      threadId,
      turnId,
      promptPreview: (raw.prompt ?? "").slice(0, 240),
      at,
      hostId,
    };
  }

  if (hookEventName === "turnstart") {
    return {
      type: "turn.started",
      threadId,
      turnId,
      promptPreview: (raw.prompt ?? "").slice(0, 240),
      at,
      hostId,
    };
  }

  if (hookEventName === "notification") {
    return {
      type: "log.appended",
      threadId,
      turnId,
      stream: "system",
      text: raw.message ?? "Codex notification",
      at,
      hostId,
    };
  }

  if (hookEventName === "pretooluse") {
    return {
      type: "step.updated",
      threadId,
      turnId,
      stepId: raw.tool_call_id ?? `${turnId}-tool`,
      label: toolLabel(raw),
      status: "running",
      at,
      hostId,
    };
  }

  if (hookEventName === "permissionrequest" || hookEventName === "approvalrequest") {
    return {
      type: "approval.requested",
      threadId,
      turnId,
      approvalId: raw.tool_call_id ?? `${turnId}-approval`,
      commandPreview: commandPreview(raw).slice(0, 240),
      at,
      hostId,
    };
  }

  if (hookEventName === "posttooluse") {
    return {
      type: "step.updated",
      threadId,
      turnId,
      stepId: raw.tool_call_id ?? `${turnId}-tool`,
      label: toolLabel(raw),
      status: toolFailed(raw.tool_response) ? "failed" : "completed",
      at,
      hostId,
    };
  }

  if (hookEventName === "stop") {
    return {
      type: "turn.completed",
      threadId,
      turnId,
      outcome: "success",
      summary: (raw.last_assistant_message ?? "Codex turn completed").slice(0, 240),
      at,
      hostId,
    };
  }

  return null;
}

function normalizeHookEventName(raw: RawHookEvent): string {
  return String(raw.hook_event_name ?? raw.eventName ?? raw.event_name ?? raw.name ?? "")
    .replace(/[_\-\s]/g, "")
    .toLowerCase();
}

function commandPreview(raw: RawHookEvent): string {
  if (raw.command) return raw.command;
  const input = asRecord(raw.tool_input);
  const command = input?.command;
  if (typeof command === "string") return command;
  return JSON.stringify(raw.tool_input ?? {});
}

function toolLabel(raw: RawHookEvent): string {
  const toolName = raw.tool_name ?? "tool";
  const command = commandPreview(raw);
  return command && command !== "{}" ? `${toolName}: ${command}`.slice(0, 120) : toolName;
}

function toolFailed(response: unknown): boolean {
  const value = asRecord(response);
  if (!value) return false;
  if (typeof value.success === "boolean") return !value.success;
  if (typeof value.exit_code === "number") return value.exit_code !== 0;
  if (typeof value.exitCode === "number") return value.exitCode !== 0;
  if (typeof value.status === "string") {
    return ["failed", "error", "cancelled"].includes(value.status.toLowerCase());
  }
  return false;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
