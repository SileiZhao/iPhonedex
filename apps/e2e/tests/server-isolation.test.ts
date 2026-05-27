import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildServer } from "@codex-monitor/server";

const root = resolve(import.meta.dirname, "../../..");

describe("monitor e2e", () => {
  afterEach(() => {
    delete process.env.RELAY_TOKEN;
    delete process.env.MOBILE_TOKEN;
  });

  it("accepts relay events and exposes mobile snapshots", async () => {
    process.env.RELAY_TOKEN = "relay-secret";
    process.env.MOBILE_TOKEN = "mobile-secret";
    const app = await buildServer({ databaseUrl: ":memory:" });

    for (const event of [
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
        promptPreview: "ship",
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
    ]) {
      const response = await app.inject({
        method: "POST",
        url: "/relay/events",
        headers: { authorization: "Bearer relay-secret" },
        payload: event,
      });
      expect(response.statusCode).toBe(202);
    }

    const response = await app.inject({
      method: "GET",
      url: "/api/threads",
      headers: { authorization: "Bearer mobile-secret" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject([
      { threadId: "thread-1", status: "waiting_for_approval" },
    ]);

    await app.close();
  });

  it("broadcasts relay events to authenticated live mobile clients", async () => {
    process.env.RELAY_TOKEN = "relay-secret";
    process.env.MOBILE_TOKEN = "mobile-secret";
    const app = await buildServer({ databaseUrl: ":memory:" });
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected TCP server address");
    }

    const messagePromise = new Promise<unknown>((resolveMessage, reject) => {
      const socket = new WebSocket(
        `ws://127.0.0.1:${address.port}/api/live?token=mobile-secret`,
      );
      socket.addEventListener("message", (message) => {
        socket.close();
        resolveMessage(JSON.parse(String(message.data)));
      });
      socket.addEventListener("error", reject);
    });

    await new Promise((resolveOpen) => setTimeout(resolveOpen, 50));

    const relayResponse = await fetch(
      `http://127.0.0.1:${address.port}/relay/events`,
      {
        method: "POST",
        headers: {
          authorization: "Bearer relay-secret",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          type: "thread.started",
          threadId: "thread-live",
          title: "Live Monitor",
          at: "2026-05-26T10:00:00.000Z",
          hostId: "mac-mini",
        }),
      },
    );

    expect(relayResponse.status).toBe(202);
    await expect(messagePromise).resolves.toMatchObject({
      type: "event",
      event: { threadId: "thread-live", title: "Live Monitor" },
    });

    await app.close();
  });

  it("keeps monitor deployment isolated from the public website ports", async () => {
    const compose = await readFile(
      resolve(root, "deploy/docker-compose.codex-monitor.yml"),
      "utf8",
    );
    const subdomain = await readFile(
      resolve(root, "deploy/nginx/codex-monitor-subdomain.conf"),
      "utf8",
    );
    const path = await readFile(
      resolve(root, "deploy/nginx/codex-monitor-path.conf"),
      "utf8",
    );

    expect(compose).toContain('"127.0.0.1:18787:8787"');
    expect(subdomain).toContain("proxy_pass http://127.0.0.1:18787;");
    expect(subdomain).toMatch(/^\s*ssl_certificate\s+/m);
    expect(subdomain).toMatch(/^\s*ssl_certificate_key\s+/m);
    expect(path).toContain("location /codex-monitor/");
    expect(path).toContain("proxy_pass http://127.0.0.1:18787/;");
  });

  it("declares iOS local network access for physical device smoke tests", async () => {
    const project = await readFile(resolve(root, "apps/ios/project.yml"), "utf8");

    expect(project).toContain("NSAllowsLocalNetworking: true");
    expect(project).toContain("NSLocalNetworkUsageDescription:");
  });

  it("provides a persistent macOS smoke server workflow", async () => {
    const script = await readFile(resolve(root, "scripts/local-smoke.sh"), "utf8");

    expect(script).toContain("usage()");
    expect(script).toContain("start_smoke_server()");
    expect(script).toContain("status_smoke_server()");
    expect(script).toContain("stop_smoke_server()");
    expect(script).toContain("launchctl bootstrap");
  });
});
