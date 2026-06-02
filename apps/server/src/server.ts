import websocket from "@fastify/websocket";
import { randomUUID } from "node:crypto";
import fastify from "fastify";
import {
  isCodexMonitorEvent,
  redactEvent,
  type CodexMonitorEvent,
} from "@codex-monitor/protocol";
import {
  NoopPushProvider,
  type PushEnvironment,
  type PushNotification,
  type PushProvider,
} from "./apns.js";
import { getRequiredEnv, requireBearer } from "./auth.js";
import { EventStore } from "./store.js";

interface BuildOptions {
  databaseUrl: string;
  pushProvider?: PushProvider;
}

interface MobileClient {
  send(payload: string): void;
}

function getErrorResponse(error: unknown): { statusCode: number; message: string } {
  if (error instanceof Error) {
    const statusCode = (error as Error & { statusCode?: unknown }).statusCode;
    return {
      statusCode: typeof statusCode === "number" ? statusCode : 500,
      message: error.message,
    };
  }
  return { statusCode: 500, message: "Internal Server Error" };
}

export async function buildServer(options: BuildOptions) {
  const app = fastify({ logger: false });
  const store = new EventStore(options.databaseUrl);
  const pushProvider = options.pushProvider ?? new NoopPushProvider();
  const mobileClients = new Set<MobileClient>();

  await app.register(websocket);

  app.setErrorHandler((error, _request, reply) => {
    const response = getErrorResponse(error);
    reply.code(response.statusCode).send({ error: response.message });
  });

  app.addHook("onClose", async () => {
    store.close();
  });

  app.get("/health", async () => {
    store.healthCheck();
    return {
      ok: true,
      database: "ok",
      push: pushProvider.configured === false ? "disabled" : "configured",
    };
  });

  app.post("/relay/events", async (request, reply) => {
    requireBearer(request, getRequiredEnv("RELAY_TOKEN"));
    const body = request.body;
    if (!isCodexMonitorEvent(body)) {
      return reply.code(400).send({ error: "Invalid event" });
    }

    const event: CodexMonitorEvent = redactEvent(body);
    store.insert(event);
    broadcastEvent(mobileClients, event);
    await notifyDevices(store, pushProvider, event);
    return reply.code(202).send({ ok: true });
  });

  app.post("/relay/events/batch", async (request, reply) => {
    requireBearer(request, getRequiredEnv("RELAY_TOKEN"));
    const body = request.body;
    if (!isEventBatch(body)) {
      return reply.code(400).send({ error: "Invalid event batch" });
    }

    const events = body.events.map((event) => redactEvent(event));
    store.insertMany(events);
    for (const event of events) {
      broadcastEvent(mobileClients, event);
      await notifyDevices(store, pushProvider, event);
    }
    return reply.code(202).send({ ok: true, count: events.length });
  });

  app.post("/api/commands", async (request, reply) => {
    requireBearer(request, getRequiredEnv("MOBILE_TOKEN"));
    const body = request.body;
    if (!isCommandRequest(body)) {
      return reply.code(400).send({ error: "Invalid command request" });
    }
    if (!remoteCommandsEnabled()) {
      return reply.code(403).send({ error: "Remote commands are disabled" });
    }

    const at = new Date().toISOString();
    const commandId = randomUUID();
    const command = {
      id: commandId,
      hostId: body.hostId.trim(),
      threadId: optionalTrimmed(body.threadId),
      cwd: optionalTrimmed(body.cwd),
      prompt: body.prompt.trim().slice(0, 8000),
      at,
    };
    if (!allowedValue("REMOTE_COMMAND_HOST_ALLOWLIST", command.hostId)) {
      return reply.code(403).send({ error: "Host is not allowed for remote commands" });
    }
    if (command.cwd && !allowedPath("REMOTE_COMMAND_CWD_ALLOWLIST", command.cwd)) {
      return reply.code(403).send({ error: "Working directory is not allowed" });
    }
    store.enqueueCommand(command);

    const threadId = command.threadId ?? `mobile-command-${commandId}`;
    const events: CodexMonitorEvent[] = [
      {
        type: "thread.started",
        threadId,
        title: command.prompt.slice(0, 80),
        cwd: command.cwd,
        at,
        hostId: command.hostId,
      },
      {
        type: "turn.started",
        threadId,
        turnId: commandId,
        promptPreview: command.prompt.slice(0, 240),
        at,
        hostId: command.hostId,
      },
      {
        type: "log.appended",
        threadId,
        turnId: commandId,
        stream: "user",
        text: command.prompt,
        at,
        hostId: command.hostId,
      },
      {
        type: "step.updated",
        threadId,
        turnId: commandId,
        stepId: `remote-command-${commandId}`,
        label: "Queued from iPhone",
        status: "queued",
        at,
        hostId: command.hostId,
      },
    ];
    for (const event of events) {
      const redacted = redactEvent(event);
      store.insert(redacted);
      broadcastEvent(mobileClients, redacted);
    }

    return reply.code(202).send({ ok: true, commandId });
  });

  app.post("/api/approvals", async (request, reply) => {
    requireBearer(request, getRequiredEnv("MOBILE_TOKEN"));
    const body = request.body;
    if (!isApprovalActionRequest(body)) {
      return reply.code(400).send({ error: "Invalid approval action request" });
    }
    if (!remoteCommandsEnabled()) {
      return reply.code(403).send({ error: "Remote commands are disabled" });
    }

    const at = new Date().toISOString();
    const commandId = randomUUID();
    const command = {
      id: commandId,
      hostId: body.hostId.trim(),
      threadId: body.threadId.trim(),
      cwd: optionalTrimmed(body.cwd),
      approvalId: body.approvalId.trim(),
      action: body.action,
      commandPreview: optionalTrimmed(body.commandPreview)?.slice(0, 1000),
      at,
    };
    if (!allowedValue("REMOTE_COMMAND_HOST_ALLOWLIST", command.hostId)) {
      return reply.code(403).send({ error: "Host is not allowed for remote commands" });
    }
    if (command.cwd && !allowedPath("REMOTE_COMMAND_CWD_ALLOWLIST", command.cwd)) {
      return reply.code(403).send({ error: "Working directory is not allowed" });
    }
    store.enqueueApprovalAction(command);

    const label = command.action === "approve" ? "Approve from iPhone" : "Reject from iPhone";
    const events: CodexMonitorEvent[] = [
      {
        type: "log.appended",
        threadId: command.threadId,
        turnId: commandId,
        stream: "user",
        text:
          command.action === "approve"
            ? "iPhone requested approval for the pending Codex action."
            : "iPhone rejected the pending Codex action.",
        at,
        hostId: command.hostId,
      },
      {
        type: "step.updated",
        threadId: command.threadId,
        turnId: commandId,
        stepId: `approval-action-${commandId}`,
        label,
        status: "queued",
        at,
        hostId: command.hostId,
      },
    ];
    for (const event of events) {
      const redacted = redactEvent(event);
      store.insert(redacted);
      broadcastEvent(mobileClients, redacted);
    }

    return reply.code(202).send({ ok: true, commandId });
  });

  app.get("/relay/commands", async (request, reply) => {
    requireBearer(request, getRequiredEnv("RELAY_TOKEN"));
    if (!remoteCommandsEnabled()) {
      return reply.code(403).send({ error: "Remote commands are disabled" });
    }
    const hostId = hostIdFromQuery(request.query);
    if (!hostId) {
      return reply.code(400).send({ error: "Missing hostId" });
    }
    if (!allowedValue("REMOTE_COMMAND_HOST_ALLOWLIST", hostId)) {
      return reply.code(403).send({ error: "Host is not allowed for remote commands" });
    }
    return store.claimQueuedCommands(hostId, 5, remoteCommandLeaseMs());
  });

  app.post("/relay/commands/:id/complete", async (request, reply) => {
    requireBearer(request, getRequiredEnv("RELAY_TOKEN"));
    if (!remoteCommandsEnabled()) {
      return reply.code(403).send({ error: "Remote commands are disabled" });
    }
    const id = (request.params as { id?: string }).id;
    const body = request.body;
    if (!id || !isCommandCompletion(body)) {
      return reply.code(400).send({ error: "Invalid command completion" });
    }
    const updated = store.completeCommand(id, body.status, optionalTrimmed(body.summary));
    return reply.code(updated ? 202 : 404).send(updated ? { ok: true } : { error: "Command not found" });
  });

  app.post("/api/devices/register", async (request, reply) => {
    requireBearer(request, getRequiredEnv("MOBILE_TOKEN"));
    const body = request.body;
    if (!isDeviceRegistration(body)) {
      return reply.code(400).send({ error: "Invalid device registration" });
    }

    store.registerDeviceToken(body.token, body.environment);
    return reply.code(202).send({ ok: true });
  });

  app.get("/api/threads", async (request) => {
    requireBearer(request, getRequiredEnv("MOBILE_TOKEN"));
    return store.listSnapshots();
  });

  app.get("/api/live", { websocket: true }, (socket, request) => {
    try {
      requireBearer(request, getRequiredEnv("MOBILE_TOKEN"));
    } catch {
      socket.close(1008, "Unauthorized");
      return;
    }

    const client = { send: (payload: string) => socket.send(payload) };
    mobileClients.add(client);
    socket.on("close", () => {
      mobileClients.delete(client);
    });
  });

  return app;
}

function broadcastEvent(clients: Set<MobileClient>, event: CodexMonitorEvent): void {
  const payload = JSON.stringify({ type: "event", event });
  for (const client of clients) {
    try {
      client.send(payload);
    } catch {
      clients.delete(client);
    }
  }
}

function isEventBatch(value: unknown): value is { events: CodexMonitorEvent[] } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const events = (value as { events?: unknown }).events;
  return Array.isArray(events) &&
    events.length > 0 &&
    events.length <= 250 &&
    events.every(isCodexMonitorEvent);
}

function isDeviceRegistration(value: unknown): value is {
  token: string;
  environment: PushEnvironment;
} {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.token === "string" &&
    candidate.token.trim().length > 0 &&
    candidate.token.length <= 512 &&
    (candidate.environment === "sandbox" || candidate.environment === "production")
  );
}

function isCommandRequest(value: unknown): value is {
  hostId: string;
  threadId?: string;
  cwd?: string;
  prompt: string;
} {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.hostId === "string" &&
    candidate.hostId.trim().length > 0 &&
    candidate.hostId.length <= 200 &&
    typeof candidate.prompt === "string" &&
    candidate.prompt.trim().length > 0 &&
    candidate.prompt.length <= 8000 &&
    optionalString(candidate.threadId, 200) &&
    optionalString(candidate.cwd, 2000)
  );
}

function isApprovalActionRequest(value: unknown): value is {
  hostId: string;
  threadId: string;
  cwd?: string;
  approvalId: string;
  action: "approve" | "reject";
  commandPreview?: string;
} {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.hostId === "string" &&
    candidate.hostId.trim().length > 0 &&
    candidate.hostId.length <= 200 &&
    typeof candidate.threadId === "string" &&
    candidate.threadId.trim().length > 0 &&
    candidate.threadId.length <= 200 &&
    typeof candidate.approvalId === "string" &&
    candidate.approvalId.trim().length > 0 &&
    candidate.approvalId.length <= 200 &&
    (candidate.action === "approve" || candidate.action === "reject") &&
    optionalString(candidate.cwd, 2000) &&
    optionalString(candidate.commandPreview, 1000)
  );
}

function isCommandCompletion(value: unknown): value is {
  status: "completed" | "failed";
  summary?: string;
} {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    (candidate.status === "completed" || candidate.status === "failed") &&
    optionalString(candidate.summary, 4000)
  );
}

function optionalString(value: unknown, maxLength: number): boolean {
  return value === undefined || (typeof value === "string" && value.length <= maxLength);
}

function optionalTrimmed(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function hostIdFromQuery(query: unknown): string | undefined {
  if (!query || typeof query !== "object") return undefined;
  const value = (query as Record<string, unknown>).hostId;
  return optionalTrimmed(value);
}

function remoteCommandsEnabled(): boolean {
  return process.env.REMOTE_COMMANDS_ENABLED === "true";
}

function remoteCommandLeaseMs(): number {
  const parsed = Number(process.env.REMOTE_COMMAND_LEASE_MS);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 5 * 60_000;
}

function allowedValue(envName: string, value: string): boolean {
  return envList(envName).includes(value);
}

function allowedPath(envName: string, path: string): boolean {
  const normalized = path.replace(/\/+$/g, "");
  return envList(envName).some((allowed) => {
    const base = allowed.replace(/\/+$/g, "");
    return normalized === base || normalized.startsWith(`${base}/`);
  });
}

function envList(envName: string): string[] {
  return (process.env[envName] ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

async function notifyDevices(
  store: EventStore,
  pushProvider: PushProvider,
  event: CodexMonitorEvent,
): Promise<void> {
  if (!isFreshPushEvent(event)) return;
  const notification = notificationForEvent(event);
  if (!notification) return;

  const devices = store.listDeviceTokens();
  await Promise.all(
    devices.map(async (device) => {
      try {
        await pushProvider.send(device.token, device.environment, notification);
      } catch {
        // Push delivery must not block relay ingestion or WebSocket fanout.
      }
    }),
  );
}

function notificationForEvent(event: CodexMonitorEvent): PushNotification | undefined {
  if (event.type === "log.appended" && event.stream === "assistant") {
    return {
      title: "Codex 回复",
      body: notificationBody(event.text),
      threadId: event.threadId,
      category: "reply",
    };
  }

  if (event.type === "approval.requested") {
    return {
      title: "Codex 等待批准",
      body: notificationBody(event.commandPreview),
      threadId: event.threadId,
      hostId: event.hostId,
      approvalId: event.approvalId,
      commandPreview: notificationBody(event.commandPreview),
      category: "approval",
    };
  }

  if (event.type === "turn.completed" && event.outcome === "failed") {
    return {
      title: "Codex 任务失败",
      body: notificationBody(event.summary),
      threadId: event.threadId,
      category: "failure",
    };
  }

  return undefined;
}

function isFreshPushEvent(event: CodexMonitorEvent): boolean {
  const maxAgeMs = pushEventMaxAgeMs();
  if (maxAgeMs <= 0) return true;
  const eventMs = Date.parse(event.at);
  return Number.isFinite(eventMs) && Date.now() - eventMs <= maxAgeMs;
}

function pushEventMaxAgeMs(): number {
  const parsed = Number(process.env.PUSH_EVENT_MAX_AGE_MS);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 15 * 60_000;
}

function notificationBody(text: string): string {
  const trimmed = text.trim().replace(/\s+/g, " ");
  return trimmed.length > 180 ? `${trimmed.slice(0, 177)}...` : trimmed;
}
