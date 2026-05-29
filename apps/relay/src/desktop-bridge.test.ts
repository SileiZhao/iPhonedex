import { describe, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readRolloutIncrement,
  buildThreadPulseEvents,
  eventAtFromLogRow,
  eventKey,
  parseRolloutEvents,
  parseToolCallLog,
  recentThreads,
  refreshCodexDesktopThread,
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
      rollout_path: "/Users/example/.codex/sessions/rollout.jsonl",
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
        cwd: "/Users/example/Repo",
        threadSource: "user",
        at: "2026-05-27T08:53:15.250Z",
        hostId: "macbook",
      },
      {
        type: "log.appended",
        threadId: "thread-1",
        turnId: "thread-1-desktop-pulse",
        stream: "system",
        text: "Codex Desktop activity in /Users/example/Repo",
        at: "2026-05-27T08:53:15.250Z",
        hostId: "macbook",
      },
    ]);
  });

  test("uses the first non-empty title line for desktop thread names", () => {
    const row: CodexThreadRow = {
      id: "thread-1",
      title: "Fix monitor sync\n\nDetailed prompt body that should not become the title",
      preview: "fallback preview",
      cwd: "/Users/example/Repo",
      rollout_path: "/Users/example/.codex/sessions/rollout.jsonl",
      updated_at_ms: 1779871995250,
      source: "vscode",
      thread_source: "user",
    };

    expect(buildThreadPulseEvents(row, "macbook")[0]).toMatchObject({
      type: "thread.started",
      title: "Fix monitor sync",
    });
  });

  test("prefers explicit local title overrides for desktop thread names", () => {
    const previousOverrides = process.env.DESKTOP_BRIDGE_THREAD_TITLE_OVERRIDES;
    process.env.DESKTOP_BRIDGE_THREAD_TITLE_OVERRIDES = JSON.stringify({
      "thread-1": "codex iPhone agent v2",
    });

    try {
      const row: CodexThreadRow = {
        id: "thread-1",
        title: "下面这段可以直接复制到新对话，作为项目记忆使用，确保完整理解整个项目：",
        preview: "fallback preview",
        cwd: "/Users/example/Codex iPhone Agent",
        rollout_path: "/Users/example/.codex/sessions/rollout.jsonl",
        updated_at_ms: 1779871995250,
        source: "vscode",
        thread_source: "user",
      };

      expect(buildThreadPulseEvents(row, "macbook")[0]).toMatchObject({
        type: "thread.started",
        title: "codex iPhone agent v2",
      });
    } finally {
      if (previousOverrides === undefined) {
        delete process.env.DESKTOP_BRIDGE_THREAD_TITLE_OVERRIDES;
      } else {
        process.env.DESKTOP_BRIDGE_THREAD_TITLE_OVERRIDES = previousOverrides;
      }
    }
  });

  test("uses Codex session index names before SQLite prompt titles", () => {
    const dir = mkdtempSync(join(tmpdir(), "codex-monitor-session-index-"));
    const indexPath = join(dir, "session_index.jsonl");
    const previousIndexPath = process.env.DESKTOP_BRIDGE_SESSION_INDEX_PATH;
    process.env.DESKTOP_BRIDGE_SESSION_INDEX_PATH = indexPath;
    appendFileSync(
      indexPath,
      `${JSON.stringify({ id: "thread-1", thread_name: "codex iPhone agent v2" })}\n`,
    );

    try {
      const row: CodexThreadRow = {
        id: "thread-1",
        title: "下面这段可以直接复制到新对话，作为项目记忆使用，确保完整理解整个项目：",
        preview: "fallback preview",
        cwd: "/Users/example/Codex iPhone Agent",
        rollout_path: "/Users/example/.codex/sessions/rollout.jsonl",
        updated_at_ms: 1779871995250,
        source: "vscode",
        thread_source: "user",
      };

      expect(buildThreadPulseEvents(row, "macbook")[0]).toMatchObject({
        type: "thread.started",
        title: "codex iPhone agent v2",
      });
    } finally {
      if (previousIndexPath === undefined) {
        delete process.env.DESKTOP_BRIDGE_SESSION_INDEX_PATH;
      } else {
        process.env.DESKTOP_BRIDGE_SESSION_INDEX_PATH = previousIndexPath;
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("re-emits desktop thread pulses when the visible title changes", () => {
    expect(
      eventKey({
        type: "thread.started",
        threadId: "thread-1",
        title: "Old title",
        cwd: "/repo",
        at: "2026-05-27T08:53:15.250Z",
        hostId: "macbook",
      }),
    ).not.toBe(
      eventKey({
        type: "thread.started",
        threadId: "thread-1",
        title: "New title",
        cwd: "/repo",
        at: "2026-05-27T08:53:15.250Z",
        hostId: "macbook",
      }),
    );
  });

  test("builds a non-destructive Codex.app refresh command for a target thread", () => {
    const calls: Array<{ command: string; args: string[] }> = [];

    refreshCodexDesktopThread("thread-1", {
      platform: "darwin",
      spawn: (command, args) => {
        calls.push({ command, args });
        return { status: 0, error: undefined };
      },
    });

    expect(calls).toEqual([
      {
        command: "osascript",
        args: expect.arrayContaining(["codex://threads/thread-1"]),
      },
    ]);
  });

  test("lists only top-level user threads from Codex desktop state", () => {
    const dir = mkdtempSync(join(tmpdir(), "codex-monitor-state-"));
    const dbPath = join(dir, "state.sqlite");
    try {
      execFileSync("sqlite3", [
        dbPath,
        `
          CREATE TABLE threads (
            id TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            preview TEXT NOT NULL,
            cwd TEXT NOT NULL,
            rollout_path TEXT NOT NULL,
            updated_at_ms INTEGER NOT NULL,
            source TEXT NOT NULL,
            thread_source TEXT,
            archived INTEGER NOT NULL DEFAULT 0
          );
          INSERT INTO threads VALUES
            ('user-thread', 'User title', 'User preview', '/repo', '/repo/user.jsonl', ${Date.now()}, 'vscode', 'user', 0),
            ('subagent-thread', 'Worker task', 'Worker preview', '/repo', '/repo/sub.jsonl', ${Date.now()}, '{"subagent":{}}', 'subagent', 0),
            ('legacy-unknown-thread', 'Legacy task', 'Legacy preview', '/repo', '/repo/legacy.jsonl', ${Date.now()}, 'vscode', NULL, 0);
        `,
      ]);

      expect(recentThreads(dbPath).map((thread) => thread.id)).toEqual(["user-thread"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("formats log timestamps with nanosecond precision truncated to milliseconds", () => {
    expect(eventAtFromLogRow({ ts: 1779871995, ts_nanos: 999999999 })).toBe(
      "2026-05-27T08:53:15.999Z",
    );
  });

  test("extracts user, reasoning, assistant, and completion events from rollout JSONL", () => {
    const content = [
      JSON.stringify({
        timestamp: "2026-05-27T08:53:14.000Z",
        type: "event_msg",
        payload: { type: "user_message", message: "请修复同步问题" },
      }),
      JSON.stringify({
        timestamp: "2026-05-27T08:53:15.000Z",
        type: "event_msg",
        payload: { type: "task_started", turn_id: "turn-1" },
      }),
      JSON.stringify({
        timestamp: "2026-05-27T08:53:16.000Z",
        type: "response_item",
        payload: {
          type: "reasoning",
          summary: [{ text: "先定位状态流" }],
        },
      }),
      JSON.stringify({
        timestamp: "2026-05-27T08:53:17.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "已经修复同步问题。" }],
        },
      }),
      JSON.stringify({
        timestamp: "2026-05-27T08:53:18.000Z",
        type: "event_msg",
        payload: { type: "task_complete", turn_id: "turn-1" },
      }),
    ].join("\n");

    expect(parseRolloutEvents(content, "thread-1", "macbook")).toEqual([
      {
        type: "turn.started",
        threadId: "thread-1",
        turnId: "turn-1",
        promptPreview: "请修复同步问题",
        at: "2026-05-27T08:53:15.000Z",
        hostId: "macbook",
      },
      {
        type: "log.appended",
        threadId: "thread-1",
        turnId: "turn-1",
        stream: "user",
        text: "请修复同步问题",
        at: "2026-05-27T08:53:15.000Z",
        hostId: "macbook",
      },
      {
        type: "log.appended",
        threadId: "thread-1",
        turnId: "turn-1",
        stream: "reasoning",
        text: "先定位状态流",
        at: "2026-05-27T08:53:16.000Z",
        hostId: "macbook",
      },
      {
        type: "log.appended",
        threadId: "thread-1",
        turnId: "turn-1",
        stream: "assistant",
        text: "已经修复同步问题。",
        at: "2026-05-27T08:53:17.000Z",
        hostId: "macbook",
      },
      {
        type: "turn.completed",
        threadId: "thread-1",
        turnId: "turn-1",
        outcome: "success",
        summary: "Codex turn completed",
        at: "2026-05-27T08:53:18.000Z",
        hostId: "macbook",
      },
    ]);
  });

  test("extracts tool call lifecycle events from rollout JSONL", () => {
    const content = [
      JSON.stringify({
        timestamp: "2026-05-27T08:53:15.000Z",
        type: "event_msg",
        payload: { type: "task_started", turn_id: "turn-1" },
      }),
      JSON.stringify({
        timestamp: "2026-05-27T08:53:16.000Z",
        type: "response_item",
        payload: {
          type: "function_call",
          name: "exec_command",
          arguments: "{\"cmd\":\"pnpm test\"}",
          call_id: "call-1",
        },
      }),
      JSON.stringify({
        timestamp: "2026-05-27T08:53:17.000Z",
        type: "response_item",
        payload: {
          type: "function_call_output",
          call_id: "call-1",
          output: "Tests passed",
        },
      }),
    ].join("\n");

    expect(parseRolloutEvents(content, "thread-1", "macbook")).toEqual([
      {
        type: "turn.started",
        threadId: "thread-1",
        turnId: "turn-1",
        promptPreview: "",
        at: "2026-05-27T08:53:15.000Z",
        hostId: "macbook",
      },
      {
        type: "step.updated",
        threadId: "thread-1",
        turnId: "turn-1",
        stepId: "codex-call-call-1",
        label: "exec_command: pnpm test",
        status: "running",
        at: "2026-05-27T08:53:16.000Z",
        hostId: "macbook",
      },
      {
        type: "log.appended",
        threadId: "thread-1",
        turnId: "turn-1",
        stream: "tool",
        text: "exec_command: pnpm test",
        at: "2026-05-27T08:53:16.000Z",
        hostId: "macbook",
      },
      {
        type: "step.updated",
        threadId: "thread-1",
        turnId: "turn-1",
        stepId: "codex-call-call-1",
        label: "exec_command: pnpm test",
        status: "completed",
        at: "2026-05-27T08:53:17.000Z",
        hostId: "macbook",
      },
      {
        type: "log.appended",
        threadId: "thread-1",
        turnId: "turn-1",
        stream: "terminal",
        text: "Tests passed",
        at: "2026-05-27T08:53:17.000Z",
        hostId: "macbook",
      },
    ]);
  });

  test("reads rollout files incrementally after a bounded bootstrap tail", () => {
    const dir = mkdtempSync(join(tmpdir(), "codex-monitor-rollout-"));
    const path = join(dir, "rollout.jsonl");
    const previousLimit = process.env.DESKTOP_BRIDGE_ROLLOUT_BOOTSTRAP_BYTES;

    try {
      const oldLine = `${JSON.stringify({
        timestamp: "2026-05-27T08:53:10.000Z",
        type: "event_msg",
        payload: { type: "agent_message", message: "old history" },
      })}\n`;
      const recentLine = `${JSON.stringify({
        timestamp: "2026-05-27T08:53:20.000Z",
        type: "event_msg",
        payload: { type: "agent_message", message: "recent answer" },
      })}\n`;
      process.env.DESKTOP_BRIDGE_ROLLOUT_BOOTSTRAP_BYTES = String(
        Buffer.byteLength(recentLine) + 1,
      );
      writeFileSync(path, oldLine.repeat(20) + recentLine);

      const state = { lastLogId: 0, emitted: [], rolloutOffsets: {} };
      expect(readRolloutIncrement(path, "thread-1", state)).toBe(recentLine);

      const nextLine = `${JSON.stringify({
        timestamp: "2026-05-27T08:53:30.000Z",
        type: "event_msg",
        payload: { type: "agent_message", message: "new answer" },
      })}\n`;
      appendFileSync(path, nextLine);

      expect(readRolloutIncrement(path, "thread-1", state)).toBe(nextLine);
    } finally {
      if (previousLimit === undefined) {
        delete process.env.DESKTOP_BRIDGE_ROLLOUT_BOOTSTRAP_BYTES;
      } else {
        process.env.DESKTOP_BRIDGE_ROLLOUT_BOOTSTRAP_BYTES = previousLimit;
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("can replay full rollout history when bootstrap bytes are set to zero", () => {
    const dir = mkdtempSync(join(tmpdir(), "codex-monitor-rollout-"));
    const path = join(dir, "rollout.jsonl");
    const previousLimit = process.env.DESKTOP_BRIDGE_ROLLOUT_BOOTSTRAP_BYTES;

    try {
      const firstLine = `${JSON.stringify({
        timestamp: "2026-05-27T08:53:10.000Z",
        type: "event_msg",
        payload: { type: "agent_message", message: "first answer" },
      })}\n`;
      const latestLine = `${JSON.stringify({
        timestamp: "2026-05-27T08:53:20.000Z",
        type: "event_msg",
        payload: { type: "agent_message", message: "latest answer" },
      })}\n`;
      process.env.DESKTOP_BRIDGE_ROLLOUT_BOOTSTRAP_BYTES = "0";
      writeFileSync(path, firstLine + latestLine);

      const state = { lastLogId: 0, emitted: [], rolloutOffsets: {} };

      expect(readRolloutIncrement(path, "thread-1", state)).toBe(firstLine + latestLine);
    } finally {
      if (previousLimit === undefined) {
        delete process.env.DESKTOP_BRIDGE_ROLLOUT_BOOTSTRAP_BYTES;
      } else {
        process.env.DESKTOP_BRIDGE_ROLLOUT_BOOTSTRAP_BYTES = previousLimit;
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
