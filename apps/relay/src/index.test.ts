import { describe, expect, it } from "vitest";
import { parseHookLine } from "./codex-source.js";
import { withRetry } from "./index.js";
import { redactBeforeUpload } from "./redact.js";

describe("relay", () => {
  it("parses codex hook json lines into monitor events", () => {
    const event = parseHookLine(
      JSON.stringify({
        hook_event_name: "UserPromptSubmit",
        session_id: "thread-1",
        turn_id: "turn-1",
        prompt: "implement monitor",
        timestamp: "2026-05-26T10:00:00.000Z",
      }),
      "mac-mini",
    );

    expect(event).toMatchObject({
      type: "turn.started",
      threadId: "thread-1",
      turnId: "turn-1",
      hostId: "mac-mini",
    });
  });

  it("parses current Codex lowerCamel hook event names", () => {
    const event = parseHookLine(
      JSON.stringify({
        hook_event_name: "permissionRequest",
        session_id: "thread-1",
        turn_id: "turn-1",
        tool_call_id: "call-1",
        tool_name: "shell",
        tool_input: { command: "pnpm build" },
        timestamp: "2026-05-26T10:01:00.000Z",
      }),
      "mac-mini",
    );

    expect(event).toMatchObject({
      type: "approval.requested",
      threadId: "thread-1",
      turnId: "turn-1",
      approvalId: "call-1",
      commandPreview: "pnpm build",
    });
  });

  it("parses official permission requests into approval events", () => {
    const event = parseHookLine(
      JSON.stringify({
        hook_event_name: "PermissionRequest",
        session_id: "thread-1",
        turn_id: "turn-1",
        tool_call_id: "call-1",
        tool_name: "shell",
        tool_input: { command: "pnpm install" },
        timestamp: "2026-05-26T10:01:00.000Z",
      }),
      "mac-mini",
    );

    expect(event).toMatchObject({
      type: "approval.requested",
      threadId: "thread-1",
      turnId: "turn-1",
      approvalId: "call-1",
      commandPreview: "pnpm install",
    });
  });

  it("parses official tool lifecycle events into step updates", () => {
    expect(
      parseHookLine(
        JSON.stringify({
          hook_event_name: "PreToolUse",
          session_id: "thread-1",
          turn_id: "turn-1",
          tool_call_id: "call-1",
          tool_name: "shell",
          tool_input: { command: "pnpm test" },
          timestamp: "2026-05-26T10:01:00.000Z",
        }),
        "mac-mini",
      ),
    ).toMatchObject({
      type: "step.updated",
      status: "running",
      label: "shell: pnpm test",
    });

    expect(
      parseHookLine(
        JSON.stringify({
          hook_event_name: "PostToolUse",
          session_id: "thread-1",
          turn_id: "turn-1",
          tool_call_id: "call-1",
          tool_name: "shell",
          tool_response: { exit_code: 1 },
          timestamp: "2026-05-26T10:02:00.000Z",
        }),
        "mac-mini",
      ),
    ).toMatchObject({
      type: "step.updated",
      status: "failed",
    });
  });

  it("redacts secrets before upload", () => {
    const event = redactBeforeUpload({
      type: "log.appended",
      threadId: "thread-1",
      turnId: "turn-1",
      stream: "terminal",
      text: "Authorization: Bearer secret",
      at: "2026-05-26T10:00:00.000Z",
      hostId: "mac-mini",
    });

    expect(event).toMatchObject({
      text: "Authorization: Bearer [REDACTED]",
    });
  });

  it("retries transient upload failures", async () => {
    let attempts = 0;

    await withRetry(
      async () => {
        attempts += 1;
        if (attempts < 3) throw new Error("temporary failure");
      },
      { attempts: 3, delayMs: 0 },
    );

    expect(attempts).toBe(3);
  });
});
