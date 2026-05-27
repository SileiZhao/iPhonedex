import websocket from "@fastify/websocket";
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
    return { ok: true, database: "ok" };
  });

  app.post("/relay/events", async (request, reply) => {
    requireBearer(request, getRequiredEnv("RELAY_TOKEN"));
    const body = request.body;
    if (!isCodexMonitorEvent(body)) {
      return reply.code(400).send({ error: "Invalid event" });
    }

    const event: CodexMonitorEvent = redactEvent(body);
    store.insert(event);
    const payload = JSON.stringify({ type: "event", event });
    for (const client of mobileClients) {
      try {
        client.send(payload);
      } catch {
        mobileClients.delete(client);
      }
    }
    await notifyDevices(store, pushProvider, event);
    return reply.code(202).send({ ok: true });
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

async function notifyDevices(
  store: EventStore,
  pushProvider: PushProvider,
  event: CodexMonitorEvent,
): Promise<void> {
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
  if (event.type === "approval.requested") {
    return {
      title: "Codex 等待批准",
      body: event.commandPreview,
      threadId: event.threadId,
      category: "approval",
    };
  }

  if (event.type === "step.updated" && event.status === "failed") {
    return {
      title: "Codex 任务失败",
      body: event.label,
      threadId: event.threadId,
      category: "failure",
    };
  }

  if (event.type === "turn.completed" && event.outcome === "failed") {
    return {
      title: "Codex 任务失败",
      body: event.summary,
      threadId: event.threadId,
      category: "failure",
    };
  }

  return undefined;
}
