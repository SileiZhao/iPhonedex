import { describe, expect, it } from "vitest";
import {
  isCodexMonitorEvent,
  redactEvent,
  reduceSnapshot,
  type CodexMonitorEvent,
} from "./index.js";

describe("protocol", () => {
  it("validates monitor events", () => {
    const event: CodexMonitorEvent = {
      type: "turn.started",
      threadId: "thread-1",
      turnId: "turn-1",
      promptPreview: "build the app",
      at: "2026-05-26T10:00:00.000Z",
      hostId: "mac-mini",
    };

    expect(isCodexMonitorEvent(event)).toBe(true);
    expect(isCodexMonitorEvent({ type: "turn.started" })).toBe(false);
  });

  it("accepts an optional cwd on thread started events", () => {
    expect(
      isCodexMonitorEvent({
        type: "thread.started",
        threadId: "thread-1",
        title: "iPhone monitor",
        cwd: "/Users/example/Repo",
        at: "2026-05-26T10:00:00.000Z",
        hostId: "mac-mini",
      }),
    ).toBe(true);

    expect(
      isCodexMonitorEvent({
        type: "thread.started",
        threadId: "thread-1",
        title: "iPhone monitor",
        cwd: 42,
        at: "2026-05-26T10:00:00.000Z",
        hostId: "mac-mini",
      }),
    ).toBe(false);
  });

  it("accepts optional thread source metadata on thread started events", () => {
    expect(
      isCodexMonitorEvent({
        type: "thread.started",
        threadId: "thread-1",
        title: "iPhone monitor",
        cwd: "/Users/example/Repo",
        threadSource: "user",
        at: "2026-05-26T10:00:00.000Z",
        hostId: "mac-mini",
      }),
    ).toBe(true);

    expect(
      isCodexMonitorEvent({
        type: "thread.started",
        threadId: "thread-1",
        title: "iPhone monitor",
        threadSource: 42,
        at: "2026-05-26T10:00:00.000Z",
        hostId: "mac-mini",
      }),
    ).toBe(false);
  });

  it("redacts secret-looking log text", () => {
    const event: CodexMonitorEvent = {
      type: "log.appended",
      threadId: "thread-1",
      turnId: "turn-1",
      stream: "terminal",
      text: "OPENAI_API_KEY=sk-live-secret-token",
      at: "2026-05-26T10:00:00.000Z",
      hostId: "mac-mini",
    };

    expect(redactEvent(event)).toMatchObject({
      text: "OPENAI_API_KEY=[REDACTED]",
    });
  });

  it("redacts secret-looking text across user-visible fields", () => {
    expect(
      redactEvent({
        type: "approval.requested",
        threadId: "thread-1",
        turnId: "turn-1",
        approvalId: "approval-1",
        commandPreview: "curl -H 'Authorization: Bearer secret-token' https://example.com",
        at: "2026-05-26T10:00:00.000Z",
        hostId: "mac-mini",
      }),
    ).toMatchObject({
      commandPreview: "curl -H 'Authorization: Bearer [REDACTED]' https://example.com",
    });

    expect(
      redactEvent({
        type: "turn.completed",
        threadId: "thread-1",
        turnId: "turn-1",
        outcome: "success",
        summary: "used OPENAI_API_KEY=sk-live-secret-token",
        at: "2026-05-26T10:00:00.000Z",
        hostId: "mac-mini",
      }),
    ).toMatchObject({
      summary: "used OPENAI_API_KEY=[REDACTED]",
    });
  });

  it("reduces events into a thread snapshot", () => {
    const events: CodexMonitorEvent[] = [
      {
        type: "thread.started",
        threadId: "thread-1",
        title: "iPhone monitor",
        at: "2026-05-26T10:00:00.000Z",
        hostId: "mac-mini",
      },
      {
        type: "turn.started",
        threadId: "thread-1",
        turnId: "turn-1",
        promptPreview: "ship it",
        at: "2026-05-26T10:01:00.000Z",
        hostId: "mac-mini",
      },
      {
        type: "approval.requested",
        threadId: "thread-1",
        turnId: "turn-1",
        approvalId: "approval-1",
        commandPreview: "pnpm install",
        at: "2026-05-26T10:02:00.000Z",
        hostId: "mac-mini",
      },
    ];

    expect(reduceSnapshot(events)).toMatchObject({
      threadId: "thread-1",
      status: "waiting_for_approval",
      currentTurnId: "turn-1",
      pendingApproval: {
        approvalId: "approval-1",
        commandPreview: "pnpm install",
      },
    });
  });

  it("clears pending approval after a turn completes", () => {
    const events: CodexMonitorEvent[] = [
      {
        type: "thread.started",
        threadId: "thread-1",
        title: "iPhone monitor",
        at: "2026-05-26T10:00:00.000Z",
        hostId: "mac-mini",
      },
      {
        type: "approval.requested",
        threadId: "thread-1",
        turnId: "turn-1",
        approvalId: "approval-1",
        commandPreview: "pnpm install",
        at: "2026-05-26T10:02:00.000Z",
        hostId: "mac-mini",
      },
      {
        type: "turn.completed",
        threadId: "thread-1",
        turnId: "turn-1",
        outcome: "success",
        summary: "installed",
        at: "2026-05-26T10:03:00.000Z",
        hostId: "mac-mini",
      },
    ];

    expect(reduceSnapshot(events).pendingApproval).toBeUndefined();
  });

  it("does not let a later desktop pulse reopen a completed turn", () => {
    const events: CodexMonitorEvent[] = [
      {
        type: "thread.started",
        threadId: "thread-1",
        title: "iPhone monitor",
        at: "2026-05-26T10:00:00.000Z",
        hostId: "mac-mini",
      },
      {
        type: "turn.started",
        threadId: "thread-1",
        turnId: "turn-1",
        promptPreview: "ship it",
        at: "2026-05-26T10:01:00.000Z",
        hostId: "mac-mini",
      },
      {
        type: "turn.completed",
        threadId: "thread-1",
        turnId: "turn-1",
        outcome: "success",
        summary: "done",
        at: "2026-05-26T10:03:00.000Z",
        hostId: "mac-mini",
      },
      {
        type: "thread.started",
        threadId: "thread-1",
        title: "iPhone monitor",
        at: "2026-05-26T10:04:00.000Z",
        hostId: "mac-mini",
      },
    ];

    expect(reduceSnapshot(events)).toMatchObject({
      status: "completed",
      currentTurnId: "turn-1",
      lastEventAt: "2026-05-26T10:04:00.000Z",
    });
  });

  it("ignores a late duplicate turn start after the same turn completed", () => {
    const events: CodexMonitorEvent[] = [
      {
        type: "thread.started",
        threadId: "thread-1",
        title: "iPhone monitor",
        at: "2026-05-26T10:00:00.000Z",
        hostId: "mac-mini",
      },
      {
        type: "turn.started",
        threadId: "thread-1",
        turnId: "turn-1",
        promptPreview: "ship it",
        at: "2026-05-26T10:01:00.000Z",
        hostId: "mac-mini",
      },
      {
        type: "turn.completed",
        threadId: "thread-1",
        turnId: "turn-1",
        outcome: "success",
        summary: "done",
        at: "2026-05-26T10:03:00.000Z",
        hostId: "mac-mini",
      },
      {
        type: "turn.started",
        threadId: "thread-1",
        turnId: "turn-1",
        promptPreview: "ship it",
        at: "2026-05-26T10:04:00.000Z",
        hostId: "mac-mini",
      },
    ];

    expect(reduceSnapshot(events)).toMatchObject({
      status: "completed",
      currentTurnId: "turn-1",
    });
  });

  it("clears stale synthetic desktop turns when a later desktop pulse arrives", () => {
    const events: CodexMonitorEvent[] = [
      {
        type: "thread.started",
        threadId: "thread-1",
        title: "Old monitor thread",
        at: "2026-05-26T10:00:00.000Z",
        hostId: "mac-mini",
      },
      {
        type: "turn.started",
        threadId: "thread-1",
        turnId: "thread-1-1779871995250",
        promptPreview: "desktop pulse",
        at: "2026-05-26T10:00:01.000Z",
        hostId: "mac-mini",
      },
      {
        type: "thread.started",
        threadId: "thread-1",
        title: "Old monitor thread",
        at: "2026-05-26T11:00:00.000Z",
        hostId: "mac-mini",
        cwd: "/Users/example/NewRepo",
      },
    ];

    expect(reduceSnapshot(events)).toMatchObject({
      status: "idle",
      currentTurnId: undefined,
      cwd: "/Users/example/NewRepo",
    });
  });

  it("keeps the latest cwd from thread started events in the snapshot", () => {
    const events: CodexMonitorEvent[] = [
      {
        type: "thread.started",
        threadId: "thread-1",
        title: "Old monitor thread",
        cwd: "/Users/example/OldRepo",
        at: "2026-05-26T10:00:00.000Z",
        hostId: "mac-mini",
      },
      {
        type: "thread.started",
        threadId: "thread-1",
        title: "New monitor thread",
        cwd: "/Users/example/NewRepo",
        at: "2026-05-26T11:00:00.000Z",
        hostId: "mac-mini",
      },
    ];

    expect(reduceSnapshot(events)).toMatchObject({
      title: "New monitor thread",
      cwd: "/Users/example/NewRepo",
    });
  });

  it("keeps the latest thread source from thread started events in the snapshot", () => {
    const events: CodexMonitorEvent[] = [
      {
        type: "thread.started",
        threadId: "thread-1",
        title: "Monitor",
        cwd: "/Users/example/Repo",
        threadSource: "subagent",
        at: "2026-05-26T10:00:00.000Z",
        hostId: "mac-mini",
      },
      {
        type: "thread.started",
        threadId: "thread-1",
        title: "Monitor",
        cwd: "/Users/example/Repo",
        threadSource: "user",
        at: "2026-05-26T11:00:00.000Z",
        hostId: "mac-mini",
      },
    ];

    expect(reduceSnapshot(events)).toMatchObject({
      threadSource: "user",
    });
  });

  it("keeps enough conversation logs for multi-turn Codex history", () => {
    const events: CodexMonitorEvent[] = [
      {
        type: "thread.started",
        threadId: "thread-1",
        title: "Monitor",
        at: "2026-05-26T10:00:00.000Z",
        hostId: "mac-mini",
      },
    ];

    for (let index = 0; index < 180; index += 1) {
      events.push({
        type: "log.appended",
        threadId: "thread-1",
        turnId: `turn-${index}`,
        stream: index % 2 === 0 ? "user" : "assistant",
        text: `message-${index}`,
        at: `2026-05-26T10:${String(index).padStart(2, "0")}:00.000Z`,
        hostId: "mac-mini",
      });
    }

    const snapshot = reduceSnapshot(events);

    expect(snapshot.recentLogs).toHaveLength(180);
    expect(snapshot.recentLogs[0]).toMatchObject({ text: "message-0" });
  });

  it("marks running steps from a completed turn as completed", () => {
    const events: CodexMonitorEvent[] = [
      {
        type: "thread.started",
        threadId: "thread-1",
        title: "Monitor",
        at: "2026-05-26T10:00:00.000Z",
        hostId: "mac-mini",
      },
      {
        type: "turn.started",
        threadId: "thread-1",
        turnId: "turn-1",
        promptPreview: "ship it",
        at: "2026-05-26T10:01:00.000Z",
        hostId: "mac-mini",
      },
      {
        type: "step.updated",
        threadId: "thread-1",
        turnId: "turn-1",
        stepId: "step-1",
        label: "Run tests",
        status: "running",
        at: "2026-05-26T10:02:00.000Z",
        hostId: "mac-mini",
      },
      {
        type: "turn.completed",
        threadId: "thread-1",
        turnId: "turn-1",
        outcome: "success",
        summary: "done",
        at: "2026-05-26T10:03:00.000Z",
        hostId: "mac-mini",
      },
    ];

    expect(reduceSnapshot(events).steps).toEqual([
      { stepId: "step-1", label: "Run tests", status: "completed" },
    ]);
  });

  it("marks a thread running when a live step starts before a turn start arrives", () => {
    const events: CodexMonitorEvent[] = [
      {
        type: "thread.started",
        threadId: "thread-1",
        title: "Monitor",
        at: "2026-05-26T10:00:00.000Z",
        hostId: "mac-mini",
      },
      {
        type: "step.updated",
        threadId: "thread-1",
        turnId: "turn-1",
        stepId: "step-1",
        label: "exec_command: pnpm test",
        status: "running",
        at: "2026-05-26T10:01:00.000Z",
        hostId: "mac-mini",
      },
    ];

    expect(reduceSnapshot(events)).toMatchObject({
      status: "running",
      currentTurnId: "turn-1",
    });
  });

  it("keeps a turn failed when a failed step is followed by a successful completion event", () => {
    const events: CodexMonitorEvent[] = [
      {
        type: "thread.started",
        threadId: "thread-1",
        title: "Monitor",
        at: "2026-05-26T10:00:00.000Z",
        hostId: "mac-mini",
      },
      {
        type: "step.updated",
        threadId: "thread-1",
        turnId: "turn-1",
        stepId: "step-1",
        label: "exec_command: pnpm test",
        status: "failed",
        at: "2026-05-26T10:01:00.000Z",
        hostId: "mac-mini",
      },
      {
        type: "turn.completed",
        threadId: "thread-1",
        turnId: "turn-1",
        outcome: "success",
        summary: "Codex handled the command failure",
        at: "2026-05-26T10:02:00.000Z",
        hostId: "mac-mini",
      },
    ];

    expect(reduceSnapshot(events).status).toBe("failed");
  });
});
