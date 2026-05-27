import { createPushProviderFromEnv } from "./apns.js";
import { buildServer } from "./server.js";

const host = process.env.HOST ?? "127.0.0.1";
const port = Number(process.env.PORT ?? "8787");
const databaseUrl =
  process.env.DATABASE_URL ?? "/var/lib/codex-monitor/events.sqlite";

const app = await buildServer({
  databaseUrl,
  pushProvider: createPushProviderFromEnv(),
});

await app.listen({ host, port });
