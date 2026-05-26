import { afterEach, describe, expect, it } from "vitest";
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
    expect(response.json()).toEqual({ ok: true });
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
});
