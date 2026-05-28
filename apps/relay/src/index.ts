import readline from "node:readline";
import { stdin } from "node:process";
import { fileURLToPath } from "node:url";
import { parseHookLine } from "./codex-source.js";
import { redactBeforeUpload } from "./redact.js";

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

async function upload(event: unknown): Promise<void> {
  const endpoint = requiredEnv("MONITOR_SERVER_URL").replace(/\/$/, "");
  const token = requiredEnv("RELAY_TOKEN");
  const response = await fetch(`${endpoint}/relay/events`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(event),
  });
  if (!response.ok) {
    throw new Error(`Upload failed: ${response.status} ${await response.text()}`);
  }
}

export async function withRetry(
  operation: () => Promise<void>,
  options: { attempts: number; delayMs: number },
): Promise<void> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= options.attempts; attempt += 1) {
    try {
      await operation();
      return;
    } catch (error) {
      lastError = error;
      if (attempt < options.attempts && options.delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, options.delayMs));
      }
    }
  }
  throw lastError;
}

export async function run(): Promise<void> {
  const hostId = process.env.HOST_ID ?? "mac";
  const reader = readline.createInterface({ input: stdin });

  for await (const line of reader) {
    const parsed = parseHookLine(line, hostId);
    if (!parsed) continue;
    await withRetry(() => upload(redactBeforeUpload(parsed)), {
      attempts: Number(process.env.RELAY_UPLOAD_ATTEMPTS ?? 3),
      delayMs: Number(process.env.RELAY_UPLOAD_RETRY_DELAY_MS ?? 1000),
    });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  run().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}
