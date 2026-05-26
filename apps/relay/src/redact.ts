import { redactEvent, type CodexMonitorEvent } from "@codex-monitor/protocol";

export function redactBeforeUpload(event: CodexMonitorEvent): CodexMonitorEvent {
  return redactEvent(event);
}
