import type { CodexMonitorEvent } from "@codex-monitor/protocol";

interface RawHookEvent {
  hook_event_name?: string;
  session_id?: string;
  prompt?: string;
  message?: string;
  command?: string;
  timestamp?: string;
}

export function parseHookLine(line: string, hostId: string): CodexMonitorEvent | null {
  const raw = JSON.parse(line) as RawHookEvent;
  const at = raw.timestamp ?? new Date().toISOString();
  const threadId = raw.session_id ?? "unknown-thread";
  const turnId = `${threadId}-${at}`;

  if (raw.hook_event_name === "UserPromptSubmit") {
    return {
      type: "thread.started",
      threadId,
      title: (raw.prompt ?? threadId).slice(0, 80),
      at,
      hostId,
    };
  }

  if (raw.hook_event_name === "TurnStart") {
    return {
      type: "turn.started",
      threadId,
      turnId,
      promptPreview: (raw.prompt ?? "").slice(0, 240),
      at,
      hostId,
    };
  }

  if (raw.hook_event_name === "Notification") {
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

  if (raw.hook_event_name === "ApprovalRequest") {
    return {
      type: "approval.requested",
      threadId,
      turnId,
      approvalId: `${turnId}-approval`,
      commandPreview: (raw.command ?? "").slice(0, 240),
      at,
      hostId,
    };
  }

  return null;
}
