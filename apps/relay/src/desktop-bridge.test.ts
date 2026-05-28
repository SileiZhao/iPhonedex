import { describe, expect, test } from "vitest";
import {
  buildThreadPulseEvents,
  eventAtFromLogRow,
  parseToolCallLog,
  type CodexLogRow,
  type CodexThreadRow,
} from "./desktop-bridge.js";

describe("desktop bridge log parsing", () => {
  test("extracts Codex tool calls without uploading raw log noise", () => {
    const row: CodexLogRow = {
      id: 42,
      ts: 1779871995,
      ts_nanos: 250000000,
      target: "codex_core::stream_events_utils",
      feedback_log_body:
        'session_loop{thread_id=thread-1}:turn{thread.id=thread-1 turn.id=turn-1 model=gpt-5.5}:handle_output_item_done: ToolCall: exec_command {"cmd":"pnpm test","workdir":"/repo"}',
      thread_id: "thread-1",
    };

    const parsed = parseToolCallLog(row, "macbook");

    expect(parsed).toEqual([
      {
        type: "step.updated",
        threadId: "thread-1",
        turnId: "turn-1",
        stepId: "codex-log-42",
        label: "exec_command: pnpm test",
        status: "running",
        at: "2026-05-27T08:53:15.250Z",
        hostId: "macbook",
      },
      {
        type: "log.appended",
        threadId: "thread-1",
        turnId: "turn-1",
        stream: "system",
        text: "exec_command: pnpm test",
        at: "2026-05-27T08:53:15.250Z",
        hostId: "macbook",
      },
    ]);
  });

  test("ignores unrelated logs", () => {
    const row: CodexLogRow = {
      id: 43,
      ts: 1779871995,
      ts_nanos: 0,
      target: "codex_api::sse::responses",
      feedback_log_body: "SSE event with full prompt",
      thread_id: "thread-1",
    };

    expect(parseToolCallLog(row, "macbook")).toEqual([]);
  });

  test("builds a running pulse for recent desktop threads", () => {
    const row: CodexThreadRow = {
      id: "thread-1",
      title: "codex iPhone agent",
      preview: "continue task",
      cwd: "/Users/example/Repo",
      updated_at_ms: 1779871995250,
      source: "vscode",
      thread_source: "user",
    };

    const events = buildThreadPulseEvents(row, "macbook");

    expect(events).toEqual([
      {
        type: "thread.started",
        threadId: "thread-1",
        title: "codex iPhone agent",
        at: "2026-05-27T08:53:15.250Z",
        hostId: "macbook",
      },
      {
        type: "turn.started",
        threadId: "thread-1",
        turnId: "thread-1-1779871995250",
        promptPreview: "continue task",
        at: "2026-05-27T08:53:15.250Z",
        hostId: "macbook",
      },
      {
        type: "log.appended",
        threadId: "thread-1",
        turnId: "thread-1-1779871995250",
        stream: "system",
        text: "Codex Desktop activity in /Users/example/Repo",
        at: "2026-05-27T08:53:15.250Z",
        hostId: "macbook",
      },
    ]);
  });

  test("formats log timestamps with nanosecond precision truncated to milliseconds", () => {
    expect(eventAtFromLogRow({ ts: 1779871995, ts_nanos: 999999999 })).toBe(
      "2026-05-27T08:53:15.999Z",
    );
  });
});
