import { afterEach, describe, expect, it } from "vitest";
import type { PushNotification, PushProvider } from "./apns.js";
import { buildServer } from "./server.js";

describe("server", () => {
  afterEach(() => {
    delete process.env.RELAY_TOKEN;
    delete process.env.MOBILE_TOKEN;
  });

  it("serves health checks without auth", async () => {
    process.env.RELAY_TOKEN = "relay-secret";
    process.env.MOBILE_TOKEN = "mobile-secret";
    const app = await buildServer({ databaseUrl: ":memory:" });

    const response = await app.inject({
      method: "GET",
      url: "/health",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, database: "ok" });
    await app.close();
  });

  it("rejects relay events without token", async () => {
    process.env.RELAY_TOKEN = "relay-secret";
    process.env.MOBILE_TOKEN = "mobile-secret";
    const app = await buildServer({ databaseUrl: ":memory:" });

    const response = await app.inject({
      method: "POST",
      url: "/relay/events",
      payload: {
        type: "thread.started",
        threadId: "thread-1",
        title: "Monitor",
        at: "2026-05-26T10:00:00.000Z",
        hostId: "mac-mini",
      },
    });

    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it("stores events and returns thread snapshots", async () => {
    process.env.RELAY_TOKEN = "relay-secret";
    process.env.MOBILE_TOKEN = "mobile-secret";
    const app = await buildServer({ databaseUrl: ":memory:" });

    const relayResponse = await app.inject({
      method: "POST",
      url: "/relay/events",
      headers: { authorization: "Bearer relay-secret" },
      payload: {
        type: "thread.started",
        threadId: "thread-1",
        title: "Monitor",
        at: "2026-05-26T10:00:00.000Z",
        hostId: "mac-mini",
      },
    });

    expect(relayResponse.statusCode).toBe(202);

    const response = await app.inject({
      method: "GET",
      url: "/api/threads",
      headers: { authorization: "Bearer mobile-secret" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject([
      { threadId: "thread-1", title: "Monitor", status: "idle" },
    ]);

    await app.close();
  });

  it("keeps same thread ids from different hosts in separate snapshots", async () => {
    process.env.RELAY_TOKEN = "relay-secret";
    process.env.MOBILE_TOKEN = "mobile-secret";
    const app = await buildServer({ databaseUrl: ":memory:" });

    for (const hostId of ["mac-mini", "macbook"]) {
      await app.inject({
        method: "POST",
        url: "/relay/events",
        headers: { authorization: "Bearer relay-secret" },
        payload: {
          type: "thread.started",
          threadId: "thread-1",
          title: `Monitor ${hostId}`,
          at: "2026-05-26T10:00:00.000Z",
          hostId,
        },
      });
    }

    const response = await app.inject({
      method: "GET",
      url: "/api/threads",
      headers: { authorization: "Bearer mobile-secret" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject([
      { threadId: "thread-1", hostId: "mac-mini" },
      { threadId: "thread-1", hostId: "macbook" },
    ]);

    await app.close();
  });

  it("registers iOS device tokens with mobile auth", async () => {
    process.env.RELAY_TOKEN = "relay-secret";
    process.env.MOBILE_TOKEN = "mobile-secret";
    const app = await buildServer({ databaseUrl: ":memory:" });

    const unauthorized = await app.inject({
      method: "POST",
      url: "/api/devices/register",
      payload: { token: "device-token-1", environment: "sandbox" },
    });
    expect(unauthorized.statusCode).toBe(401);

    const invalid = await app.inject({
      method: "POST",
      url: "/api/devices/register",
      headers: { authorization: "Bearer mobile-secret" },
      payload: { token: "", environment: "sandbox" },
    });
    expect(invalid.statusCode).toBe(400);

    const first = await app.inject({
      method: "POST",
      url: "/api/devices/register",
      headers: { authorization: "Bearer mobile-secret" },
      payload: { token: "device-token-1", environment: "sandbox" },
    });
    expect(first.statusCode).toBe(202);
    expect(first.json()).toEqual({ ok: true });

    const duplicate = await app.inject({
      method: "POST",
      url: "/api/devices/register",
      headers: { authorization: "Bearer mobile-secret" },
      payload: { token: "device-token-1", environment: "sandbox" },
    });
    expect(duplicate.statusCode).toBe(202);

    await app.close();
  });

  it("pushes APNs notifications for approvals and failures only", async () => {
    process.env.RELAY_TOKEN = "relay-secret";
    process.env.MOBILE_TOKEN = "mobile-secret";
    const pushProvider = new CapturingPushProvider();
    const app = await buildServer({
      databaseUrl: ":memory:",
      pushProvider,
    });

    await app.inject({
      method: "POST",
      url: "/api/devices/register",
      headers: { authorization: "Bearer mobile-secret" },
      payload: { token: "device-token-1", environment: "sandbox" },
    });

    await app.inject({
      method: "POST",
      url: "/relay/events",
      headers: { authorization: "Bearer relay-secret" },
      payload: {
        type: "thread.started",
        threadId: "thread-1",
        title: "Monitor",
        at: "2026-05-26T10:00:00.000Z",
        hostId: "mac-mini",
      },
    });
    expect(pushProvider.sent).toHaveLength(0);

    await app.inject({
      method: "POST",
      url: "/relay/events",
      headers: { authorization: "Bearer relay-secret" },
      payload: {
        type: "approval.requested",
        threadId: "thread-1",
        turnId: "turn-1",
        approvalId: "approval-1",
        commandPreview: "echo hello",
        at: "2026-05-26T10:00:01.000Z",
        hostId: "mac-mini",
      },
    });

    await app.inject({
      method: "POST",
      url: "/relay/events",
      headers: { authorization: "Bearer relay-secret" },
      payload: {
        type: "step.updated",
        threadId: "thread-1",
        turnId: "turn-1",
        stepId: "step-1",
        label: "Run command",
        status: "failed",
        at: "2026-05-26T10:00:02.000Z",
        hostId: "mac-mini",
      },
    });

    expect(pushProvider.sent).toEqual([
      {
        deviceToken: "device-token-1",
        environment: "sandbox",
        notification: {
          title: "Codex 等待批准",
          body: "echo hello",
          threadId: "thread-1",
          category: "approval",
        },
      },
      {
        deviceToken: "device-token-1",
        environment: "sandbox",
        notification: {
          title: "Codex 任务失败",
          body: "Run command",
          threadId: "thread-1",
          category: "failure",
        },
      },
    ]);

    await app.close();
  });
});

class CapturingPushProvider implements PushProvider {
  readonly sent: Array<{
    deviceToken: string;
    environment: "sandbox" | "production";
    notification: PushNotification;
  }> = [];

  async send(
    deviceToken: string,
    environment: "sandbox" | "production",
    notification: PushNotification,
  ): Promise<void> {
    this.sent.push({ deviceToken, environment, notification });
  }
}
