import Database from "better-sqlite3";
import {
  isCodexMonitorEvent,
  reduceSnapshot,
  type CodexMonitorEvent,
  type ThreadSnapshot,
} from "@codex-monitor/protocol";
import type { PushEnvironment } from "./apns.js";

export interface DeviceTokenRecord {
  token: string;
  environment: PushEnvironment;
  platform: "ios";
  createdAt: string;
  updatedAt: string;
}

export class EventStore {
  private db: Database.Database;

  constructor(databaseUrl: string) {
    this.db = new Database(databaseUrl);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        thread_id TEXT NOT NULL,
        host_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        event_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_events_thread_id ON events(thread_id);
      CREATE INDEX IF NOT EXISTS idx_events_host_thread ON events(host_id, thread_id);
      CREATE INDEX IF NOT EXISTS idx_events_created_at ON events(created_at);

      CREATE TABLE IF NOT EXISTS device_tokens (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        token TEXT NOT NULL UNIQUE,
        platform TEXT NOT NULL DEFAULT 'ios',
        environment TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_device_tokens_environment ON device_tokens(environment);
    `);
  }

  insert(event: CodexMonitorEvent): void {
    this.db
      .prepare(
        "INSERT INTO events (thread_id, host_id, event_type, event_json, created_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(event.threadId, event.hostId, event.type, JSON.stringify(event), event.at);
  }

  listSnapshots(): ThreadSnapshot[] {
    const rows = this.db
      .prepare("SELECT event_json FROM events ORDER BY created_at ASC, id ASC")
      .all() as Array<{ event_json: string }>;
    const grouped = new Map<string, CodexMonitorEvent[]>();

    for (const row of rows) {
      const parsed = JSON.parse(row.event_json) as unknown;
      if (!isCodexMonitorEvent(parsed)) continue;
      const key = `${parsed.hostId}\u0000${parsed.threadId}`;
      grouped.set(key, [...(grouped.get(key) ?? []), parsed]);
    }

    return Array.from(grouped.values()).map(reduceSnapshot);
  }

  registerDeviceToken(token: string, environment: PushEnvironment): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `
        INSERT INTO device_tokens (token, platform, environment, created_at, updated_at)
        VALUES (?, 'ios', ?, ?, ?)
        ON CONFLICT(token) DO UPDATE SET
          environment = excluded.environment,
          updated_at = excluded.updated_at
      `,
      )
      .run(token, environment, now, now);
  }

  listDeviceTokens(): DeviceTokenRecord[] {
    const rows = this.db
      .prepare(
        `
        SELECT token, platform, environment, created_at, updated_at
        FROM device_tokens
        ORDER BY updated_at DESC, id DESC
      `,
      )
      .all() as Array<{
      token: string;
      platform: string;
      environment: string;
      created_at: string;
      updated_at: string;
    }>;

    return rows
      .filter(
        (row) =>
          row.platform === "ios" &&
          (row.environment === "sandbox" || row.environment === "production"),
      )
      .map((row) => ({
        token: row.token,
        platform: "ios",
        environment: row.environment as PushEnvironment,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }));
  }

  healthCheck(): void {
    this.db.prepare("SELECT 1").get();
  }

  close(): void {
    this.db.close();
  }
}
