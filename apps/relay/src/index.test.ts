import { describe, expect, it } from "vitest";
import { parseHookLine } from "./codex-source.js";
import { redactBeforeUpload } from "./redact.js";

describe("relay", () => {
  it("parses codex hook json lines into monitor events", () => {
    const event = parseHookLine(
      JSON.stringify({
        hook_event_name: "TurnStart",
        session_id: "thread-1",
        prompt: "implement monitor",
        timestamp: "2026-05-26T10:00:00.000Z",
      }),
      "mac-mini",
    );

    expect(event).toMatchObject({
      type: "turn.started",
      threadId: "thread-1",
      turnId: "thread-1-2026-05-26T10:00:00.000Z",
      hostId: "mac-mini",
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
});
