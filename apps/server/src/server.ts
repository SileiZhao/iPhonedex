import websocket from "@fastify/websocket";
import fastify from "fastify";
import {
  isCodexMonitorEvent,
  redactEvent,
  type CodexMonitorEvent,
} from "@codex-monitor/protocol";
import { getRequiredEnv, requireBearer } from "./auth.js";
import { EventStore } from "./store.js";

interface BuildOptions {
  databaseUrl: string;
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
  const mobileClients = new Set<MobileClient>();

  await app.register(websocket);

  app.setErrorHandler((error, _request, reply) => {
    const response = getErrorResponse(error);
    reply.code(response.statusCode).send({ error: response.message });
  });

  app.addHook("onClose", async () => {
    store.close();
  });

  app.get("/health", async () => ({ ok: true }));

  app.post("/relay/events", async (request, reply) => {
    requireBearer(request, getRequiredEnv("RELAY_TOKEN"));
    const body = request.body;
    if (!isCodexMonitorEvent(body)) {
      return reply.code(400).send({ error: "Invalid event" });
    }

    const event: CodexMonitorEvent = redactEvent(body);
    store.insert(event);
    const payload = JSON.stringify({ type: "event", event });
    for (const client of mobileClients) client.send(payload);
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
