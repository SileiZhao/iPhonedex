import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PushNotification, PushProvider } from "./apns.js";
import { buildServer } from "./server.js";
import { EventStore } from "./store.js";

describe("server", () => {
  afterEach(() => {
    delete process.env.RELAY_TOKEN;
    delete process.env.MOBILE_TOKEN;
    delete process.env.REMOTE_COMMANDS_ENABLED;
    delete process.env.REMOTE_COMMAND_HOST_ALLOWLIST;
    delete process.env.REMOTE_COMMAND_CWD_ALLOWLIST;
    delete process.env.REMOTE_COMMAND_LEASE_MS;
    delete process.env.STALE_RUNNING_THREAD_MS;
    delete process.env.PUSH_EVENT_MAX_AGE_MS;
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
    expect(response.json()).toEqual({ ok: true, database: "ok", push: "disabled" });
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

  it("returns only Codex desktop user conversations when subagent snapshots exist in the same project", async () => {
    process.env.RELAY_TOKEN = "relay-secret";
    process.env.MOBILE_TOKEN = "mobile-secret";
    const app = await buildServer({ databaseUrl: ":memory:" });

    for (const event of [
      {
        type: "thread.started",
        threadId: "user-thread",
        title: "codex iPhone agent v2",
        cwd: "/Users/example/Codex iPhone Agent",
        threadSource: "user",
        at: "2026-05-26T10:00:00.000Z",
        hostId: "mac-mini",
      },
      {
        type: "thread.started",
        threadId: "subagent-thread",
        title: "Worker task",
        cwd: "/Users/example/Codex iPhone Agent",
        threadSource: "subagent",
        at: "2026-05-26T10:01:00.000Z",
        hostId: "mac-mini",
      },
      {
        type: "thread.started",
        threadId: "legacy-subagent",
        title: "Legacy worker task",
        cwd: "/Users/example/Codex iPhone Agent",
        at: "2026-05-26T10:02:00.000Z",
        hostId: "mac-mini",
      },
    ] as const) {
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
      {
        threadId: "user-thread",
        title: "codex iPhone agent v2",
        threadSource: "user",
      },
    ]);

    await app.close();
  });

  it("filters legacy subagent snapshots by project path even if their host id changed", async () => {
    process.env.RELAY_TOKEN = "relay-secret";
    process.env.MOBILE_TOKEN = "mobile-secret";
    const app = await buildServer({ databaseUrl: ":memory:" });

    for (const event of [
      {
        type: "thread.started",
        threadId: "main-thread",
        title: "codex iPhone agent v2",
        cwd: "/Users/example/Codex iPhone Agent",
        threadSource: "user",
        at: "2026-05-26T10:00:00.000Z",
        hostId: "MacBook-Air",
      },
      {
        type: "thread.started",
        threadId: "legacy-worker",
        title: "你是代码库探索子智能体。请只读不改文件。",
        cwd: "/Users/example/Codex iPhone Agent",
        at: "2026-05-26T10:01:00.000Z",
        hostId: "zhaosileideMacBook-Air",
      },
    ] as const) {
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
      {
        threadId: "main-thread",
        title: "codex iPhone agent v2",
        threadSource: "user",
      },
    ]);

    await app.close();
  });

  it("serves snapshots from a warmed cache instead of rescanning all events", () => {
    const dir = mkdtempSync(join(tmpdir(), "codex-monitor-store-"));
    const dbPath = join(dir, "events.sqlite");
    const prepareSpy = vi.spyOn(Database.prototype, "prepare");

    try {
      const store = new EventStore(dbPath);
      store.insert({
        type: "thread.started",
        threadId: "thread-1",
        title: "Monitor",
        at: "2026-05-26T10:00:00.000Z",
        hostId: "mac-mini",
      });
      prepareSpy.mockClear();

      expect(store.listSnapshots()).toHaveLength(1);
      expect(store.listSnapshots()).toHaveLength(1);

      const fullScans = prepareSpy.mock.calls.filter(([sql]) =>
        String(sql).includes("SELECT event_json FROM events ORDER BY created_at ASC, id ASC"),
      );
      expect(fullScans).toHaveLength(0);
      store.close();
    } finally {
      prepareSpy.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps the snapshot cache warm after relay batch inserts", () => {
    const dir = mkdtempSync(join(tmpdir(), "codex-monitor-store-"));
    const dbPath = join(dir, "events.sqlite");
    const prepareSpy = vi.spyOn(Database.prototype, "prepare");

    try {
      const store = new EventStore(dbPath);
      store.insert({
        type: "thread.started",
        threadId: "thread-1",
        title: "Monitor",
        at: "2026-05-26T10:00:00.000Z",
        hostId: "mac-mini",
      });
      expect(store.listSnapshots()).toHaveLength(1);
      prepareSpy.mockClear();

      store.insertMany([
        {
          type: "log.appended",
          threadId: "thread-1",
          turnId: "turn-1",
          stream: "assistant",
          text: "增量回复",
          at: "2026-05-26T10:00:01.000Z",
          hostId: "mac-mini",
        },
      ]);

      expect(store.listSnapshots()[0].recentLogs).toEqual([
        expect.objectContaining({ text: "增量回复" }),
      ]);
      const snapshotScans = prepareSpy.mock.calls.filter(([sql]) =>
        String(sql).includes("WITH recent_threads AS"),
      );
      expect(snapshotScans).toHaveLength(0);
      store.close();
    } finally {
      prepareSpy.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
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

  it("queues mobile commands for the desktop bridge and marks them complete", async () => {
    process.env.RELAY_TOKEN = "relay-secret";
    process.env.MOBILE_TOKEN = "mobile-secret";
    process.env.REMOTE_COMMANDS_ENABLED = "true";
    process.env.REMOTE_COMMAND_HOST_ALLOWLIST = "mac-mini";
    process.env.REMOTE_COMMAND_CWD_ALLOWLIST = "/repo";
    const app = await buildServer({ databaseUrl: ":memory:" });

    const created = await app.inject({
      method: "POST",
      url: "/api/commands",
      headers: { authorization: "Bearer mobile-secret" },
      payload: {
        hostId: "mac-mini",
        threadId: "thread-1",
        cwd: "/repo",
        prompt: "继续修复状态同步",
      },
    });

    expect(created.statusCode).toBe(202);
    expect(created.json()).toMatchObject({ ok: true, commandId: expect.any(String) });

    const unauthorized = await app.inject({
      method: "GET",
      url: "/relay/commands?hostId=mac-mini",
    });
    expect(unauthorized.statusCode).toBe(401);

    const pending = await app.inject({
      method: "GET",
      url: "/relay/commands?hostId=mac-mini",
      headers: { authorization: "Bearer relay-secret" },
    });
    expect(pending.statusCode).toBe(200);
    expect(pending.json()).toMatchObject([
      {
        id: created.json().commandId,
        hostId: "mac-mini",
        threadId: "thread-1",
        cwd: "/repo",
        prompt: "继续修复状态同步",
        status: "in_progress",
      },
    ]);

    const completed = await app.inject({
      method: "POST",
      url: `/relay/commands/${created.json().commandId}/complete`,
      headers: { authorization: "Bearer relay-secret" },
      payload: { status: "completed", summary: "ok" },
    });
    expect(completed.statusCode).toBe(202);

    const empty = await app.inject({
      method: "GET",
      url: "/relay/commands?hostId=mac-mini",
      headers: { authorization: "Bearer relay-secret" },
    });
    expect(empty.json()).toEqual([]);

    await app.close();
  });

  it("queues iPhone approval actions for the desktop bridge", async () => {
    process.env.RELAY_TOKEN = "relay-secret";
    process.env.MOBILE_TOKEN = "mobile-secret";
    process.env.REMOTE_COMMANDS_ENABLED = "true";
    process.env.REMOTE_COMMAND_HOST_ALLOWLIST = "mac-mini";
    process.env.REMOTE_COMMAND_CWD_ALLOWLIST = "/repo";
    const app = await buildServer({ databaseUrl: ":memory:" });

    const created = await app.inject({
      method: "POST",
      url: "/api/approvals",
      headers: { authorization: "Bearer mobile-secret" },
      payload: {
        hostId: "mac-mini",
        threadId: "thread-1",
        cwd: "/repo",
        approvalId: "approval-1",
        action: "approve",
        commandPreview: "pnpm test",
      },
    });

    expect(created.statusCode).toBe(202);
    expect(created.json()).toMatchObject({ ok: true, commandId: expect.any(String) });

    const pending = await app.inject({
      method: "GET",
      url: "/relay/commands?hostId=mac-mini",
      headers: { authorization: "Bearer relay-secret" },
    });

    expect(pending.statusCode).toBe(200);
    expect(pending.json()).toMatchObject([
      {
        id: created.json().commandId,
        hostId: "mac-mini",
        kind: "approval",
        threadId: "thread-1",
        cwd: "/repo",
        approval: {
          approvalId: "approval-1",
          action: "approve",
          commandPreview: "pnpm test",
        },
        status: "in_progress",
      },
    ]);

    await app.close();
  });

  it("rejects unsafe command queue payloads", async () => {
    process.env.RELAY_TOKEN = "relay-secret";
    process.env.MOBILE_TOKEN = "mobile-secret";
    process.env.REMOTE_COMMANDS_ENABLED = "true";
    process.env.REMOTE_COMMAND_HOST_ALLOWLIST = "mac-mini";
    process.env.REMOTE_COMMAND_CWD_ALLOWLIST = "/repo";
    const app = await buildServer({ databaseUrl: ":memory:" });

    const response = await app.inject({
      method: "POST",
      url: "/api/commands",
      headers: { authorization: "Bearer mobile-secret" },
      payload: { hostId: "", prompt: "" },
    });

    expect(response.statusCode).toBe(400);
    await app.close();
  });

  it("keeps remote commands behind an explicit host allowlist", async () => {
    process.env.RELAY_TOKEN = "relay-secret";
    process.env.MOBILE_TOKEN = "mobile-secret";
    let app = await buildServer({ databaseUrl: ":memory:" });

    const disabled = await app.inject({
      method: "POST",
      url: "/api/commands",
      headers: { authorization: "Bearer mobile-secret" },
      payload: { hostId: "mac-mini", prompt: "继续" },
    });
    expect(disabled.statusCode).toBe(403);
    await app.close();

    process.env.REMOTE_COMMANDS_ENABLED = "true";
    process.env.REMOTE_COMMAND_HOST_ALLOWLIST = "mac-mini";
    app = await buildServer({ databaseUrl: ":memory:" });

    const wrongHost = await app.inject({
      method: "POST",
      url: "/api/commands",
      headers: { authorization: "Bearer mobile-secret" },
      payload: { hostId: "other-mac", prompt: "继续" },
    });
    expect(wrongHost.statusCode).toBe(403);
    await app.close();
  });

  it("reclaims remote commands after the bridge lease expires", async () => {
    process.env.RELAY_TOKEN = "relay-secret";
    process.env.MOBILE_TOKEN = "mobile-secret";
    process.env.REMOTE_COMMANDS_ENABLED = "true";
    process.env.REMOTE_COMMAND_HOST_ALLOWLIST = "mac-mini";
    process.env.REMOTE_COMMAND_LEASE_MS = "1";
    const app = await buildServer({ databaseUrl: ":memory:" });

    const created = await app.inject({
      method: "POST",
      url: "/api/commands",
      headers: { authorization: "Bearer mobile-secret" },
      payload: { hostId: "mac-mini", threadId: "thread-1", prompt: "继续" },
    });
    const commandId = created.json().commandId;

    const firstClaim = await app.inject({
      method: "GET",
      url: "/relay/commands?hostId=mac-mini",
      headers: { authorization: "Bearer relay-secret" },
    });
    expect(firstClaim.json()).toMatchObject([{ id: commandId, attempts: 1 }]);

    await new Promise((resolve) => setTimeout(resolve, 5));

    const secondClaim = await app.inject({
      method: "GET",
      url: "/relay/commands?hostId=mac-mini",
      headers: { authorization: "Bearer relay-secret" },
    });
    expect(secondClaim.json()).toMatchObject([{ id: commandId, attempts: 2 }]);

    await app.close();
  });

  it("broadcasts command events to mobile clients", async () => {
    process.env.RELAY_TOKEN = "relay-secret";
    process.env.MOBILE_TOKEN = "mobile-secret";
    process.env.REMOTE_COMMANDS_ENABLED = "true";
    process.env.REMOTE_COMMAND_HOST_ALLOWLIST = "mac-mini";
    process.env.REMOTE_COMMAND_CWD_ALLOWLIST = "/repo";
    const app = await buildServer({ databaseUrl: ":memory:" });

    const created = await app.inject({
      method: "POST",
      url: "/api/commands",
      headers: { authorization: "Bearer mobile-secret" },
      payload: {
        hostId: "mac-mini",
        threadId: "thread-1",
        cwd: "/repo",
        prompt: "请继续",
      },
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/threads",
      headers: { authorization: "Bearer mobile-secret" },
    });

    expect(response.json()).toMatchObject([
      {
        threadId: "thread-1",
        cwd: "/repo",
        recentLogs: [
          {
            stream: "user",
            text: "请继续",
          },
        ],
      },
    ]);
    expect(created.statusCode).toBe(202);
    await app.close();
  });

  it("accepts relay event batches and reduces them into snapshots", async () => {
    process.env.RELAY_TOKEN = "relay-secret";
    process.env.MOBILE_TOKEN = "mobile-secret";
    const app = await buildServer({ databaseUrl: ":memory:" });

    const response = await app.inject({
      method: "POST",
      url: "/relay/events/batch",
      headers: { authorization: "Bearer relay-secret" },
      payload: {
        events: [
          {
            type: "thread.started",
            threadId: "thread-1",
            title: "Monitor",
            at: "2026-05-26T10:00:00.000Z",
            hostId: "mac-mini",
          },
          {
            type: "log.appended",
            threadId: "thread-1",
            turnId: "turn-1",
            stream: "assistant",
            text: "历史回复",
            at: "2026-05-26T10:00:01.000Z",
            hostId: "mac-mini",
          },
        ],
      },
    });

    const threads = await app.inject({
      method: "GET",
      url: "/api/threads",
      headers: { authorization: "Bearer mobile-secret" },
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({ count: 2 });
    expect(threads.json()).toMatchObject([
      {
        threadId: "thread-1",
        recentLogs: [{ stream: "assistant", text: "历史回复" }],
      },
    ]);
    await app.close();
  });

  it("deduplicates relay events when a bridge replay retries the same batch", async () => {
    process.env.RELAY_TOKEN = "relay-secret";
    process.env.MOBILE_TOKEN = "mobile-secret";
    const app = await buildServer({ databaseUrl: ":memory:" });
    const batch = {
      events: [
        {
          type: "thread.started",
          threadId: "thread-1",
          title: "Monitor",
          at: "2026-05-26T10:00:00.000Z",
          hostId: "mac-mini",
        },
        {
          type: "log.appended",
          threadId: "thread-1",
          turnId: "turn-1",
          stream: "assistant",
          text: "同一条历史回复",
          at: "2026-05-26T10:00:01.000Z",
          hostId: "mac-mini",
        },
      ],
    };

    for (let index = 0; index < 2; index += 1) {
      const response = await app.inject({
        method: "POST",
        url: "/relay/events/batch",
        headers: { authorization: "Bearer relay-secret" },
        payload: batch,
      });
      expect(response.statusCode).toBe(202);
    }

    const threads = await app.inject({
      method: "GET",
      url: "/api/threads",
      headers: { authorization: "Bearer mobile-secret" },
    });

    expect(threads.json()[0].recentLogs).toEqual([
      expect.objectContaining({ stream: "assistant", text: "同一条历史回复" }),
    ]);
    await app.close();
  });

  it("does not keep stale historical running turns in the active count", async () => {
    process.env.RELAY_TOKEN = "relay-secret";
    process.env.MOBILE_TOKEN = "mobile-secret";
    process.env.STALE_RUNNING_THREAD_MS = "1";
    const app = await buildServer({ databaseUrl: ":memory:" });
    const oldAt = new Date(Date.now() - 60_000).toISOString();

    await app.inject({
      method: "POST",
      url: "/relay/events",
      headers: { authorization: "Bearer relay-secret" },
      payload: {
        type: "turn.started",
        threadId: "thread-1",
        turnId: "turn-1",
        promptPreview: "old unfinished turn",
        at: oldAt,
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
        label: "old step",
        status: "running",
        at: oldAt,
        hostId: "mac-mini",
      },
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/threads",
      headers: { authorization: "Bearer mobile-secret" },
    });

    expect(response.json()).toMatchObject([
      {
        status: "idle",
        steps: [{ stepId: "step-1", status: "completed" }],
      },
    ]);
    await app.close();
  });

  it("pushes APNs notifications for fresh replies, approvals, and failures only", async () => {
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
        at: new Date().toISOString(),
        hostId: "mac-mini",
      },
    });
    expect(pushProvider.sent).toHaveLength(0);

    await app.inject({
      method: "POST",
      url: "/relay/events",
      headers: { authorization: "Bearer relay-secret" },
      payload: {
        type: "log.appended",
        threadId: "thread-1",
        turnId: "turn-1",
        stream: "assistant",
        text: "已经完成，可以在 iPhone 上查看结果。",
        at: new Date().toISOString(),
        hostId: "mac-mini",
      },
    });

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
        at: new Date().toISOString(),
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
        at: new Date().toISOString(),
        hostId: "mac-mini",
      },
    });

    expect(pushProvider.sent).toEqual([
      {
        deviceToken: "device-token-1",
        environment: "sandbox",
        notification: {
          title: "Codex 回复",
          body: "已经完成，可以在 iPhone 上查看结果。",
          threadId: "thread-1",
          category: "reply",
        },
      },
      {
        deviceToken: "device-token-1",
        environment: "sandbox",
        notification: {
          title: "Codex 等待批准",
          body: "echo hello",
          threadId: "thread-1",
          hostId: "mac-mini",
          approvalId: "approval-1",
          commandPreview: "echo hello",
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

  it("does not push notifications for stale replayed assistant logs", async () => {
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
        type: "log.appended",
        threadId: "thread-1",
        turnId: "turn-1",
        stream: "assistant",
        text: "这是历史回放里的旧回复。",
        at: "2026-05-26T10:00:00.000Z",
        hostId: "mac-mini",
      },
    });

    expect(pushProvider.sent).toEqual([]);

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
