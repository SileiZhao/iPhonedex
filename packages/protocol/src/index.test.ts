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
});
