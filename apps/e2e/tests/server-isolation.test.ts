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
    expect(path).toContain("location /codex-monitor/");
    expect(path).toContain("proxy_pass http://127.0.0.1:18787/;");
  });
});
