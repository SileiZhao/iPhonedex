import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import {
  isCodexMonitorEvent,
  reduceSnapshot,
  type CodexMonitorEvent,
  type ThreadSnapshot,
} from "@codex-monitor/protocol";
import type { PushEnvironment } from "./apns.js";

export interface RemoteCommandRecord {
  id: string;
  hostId: string;
  threadId?: string;
  cwd?: string;
  prompt: string;
  status: "queued" | "in_progress" | "completed" | "failed";
  attempts: number;
  claimedAt?: string;
  leaseExpiresAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface DeviceTokenRecord {
  token: string;
  environment: PushEnvironment;
  platform: "ios";
  createdAt: string;
  updatedAt: string;
}

export class EventStore {
  private db: Database.Database;
  private snapshotEvents = new Map<string, CodexMonitorEvent[]>();
  private snapshots = new Map<string, ThreadSnapshot>();
  private snapshotCacheHydrated = false;

  constructor(databaseUrl: string) {
    this.db = new Database(databaseUrl);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        thread_id TEXT NOT NULL,
        host_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        event_key TEXT,
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

      CREATE TABLE IF NOT EXISTS remote_commands (
        id TEXT PRIMARY KEY,
        host_id TEXT NOT NULL,
        thread_id TEXT,
        cwd TEXT,
        prompt TEXT NOT NULL,
        status TEXT NOT NULL,
        summary TEXT,
        claimed_at TEXT,
        lease_expires_at TEXT,
        attempts INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_remote_commands_host_status
        ON remote_commands(host_id, status, created_at);
    `);
    this.ensureEventColumn("event_key", "TEXT");
    this.db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_events_event_key
        ON events(event_key)
        WHERE event_key IS NOT NULL;
    `);
    this.ensureRemoteCommandColumn("claimed_at", "TEXT");
    this.ensureRemoteCommandColumn("lease_expires_at", "TEXT");
    this.ensureRemoteCommandColumn("attempts", "INTEGER NOT NULL DEFAULT 0");
  }

  insert(event: CodexMonitorEvent): void {
    const result = this.db
      .prepare(
        `
        INSERT OR IGNORE INTO events
          (thread_id, host_id, event_type, event_key, event_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `,
      )
      .run(
        event.threadId,
        event.hostId,
        event.type,
        eventKey(event),
        JSON.stringify(event),
        event.at,
      );
    if (result.changes === 0) return;
    this.applyEventToSnapshotCache(event);
  }

  insertMany(events: CodexMonitorEvent[]): void {
    if (events.length === 0) return;
    const insert = this.db.prepare(
      `
      INSERT OR IGNORE INTO events
        (thread_id, host_id, event_type, event_key, event_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `,
    );
    const transaction = this.db.transaction((items: CodexMonitorEvent[]) => {
      const inserted: CodexMonitorEvent[] = [];
      for (const event of items) {
        const result = insert.run(
          event.threadId,
          event.hostId,
          event.type,
          eventKey(event),
          JSON.stringify(event),
          event.at,
        );
        if (result.changes > 0) inserted.push(event);
      }
      return inserted;
    });
    const inserted = transaction(events);
    if (inserted.length === 0) return;
    if (this.snapshotCacheHydrated) {
      for (const event of inserted) this.applyEventToSnapshotCache(event);
      return;
    }
  }

  listSnapshots(): ThreadSnapshot[] {
    if (!this.snapshotCacheHydrated) {
      this.hydrateSnapshotCache();
    }
    return visibleDesktopSnapshots(
      Array.from(this.snapshots.values()).map(normalizeStaleSnapshot),
    );
  }

  private hydrateSnapshotCache(): void {
    this.snapshotEvents.clear();
    this.snapshots.clear();
    const threadLimit = boundedPositiveNumber("SNAPSHOT_THREAD_LIMIT", 50);
    const eventsPerThread = boundedPositiveNumber("SNAPSHOT_EVENTS_PER_THREAD", 5000);
    const rows = this.db
      .prepare(
        `
        WITH recent_threads AS (
          SELECT host_id, thread_id, MAX(created_at) AS last_at, MAX(id) AS last_id
          FROM events
          GROUP BY host_id, thread_id
          ORDER BY last_at DESC, last_id DESC
          LIMIT ?
        ),
        ranked_events AS (
          SELECT e.event_json, e.host_id, e.thread_id, e.created_at, e.id,
            ROW_NUMBER() OVER (
              PARTITION BY e.host_id, e.thread_id
              ORDER BY e.created_at DESC, e.id DESC
            ) AS rn
          FROM events e
          INNER JOIN recent_threads rt
            ON rt.host_id = e.host_id AND rt.thread_id = e.thread_id
        )
        SELECT event_json
        FROM ranked_events
        WHERE rn <= ?
        ORDER BY host_id ASC, thread_id ASC, created_at ASC, id ASC
      `,
      )
      .all(threadLimit, eventsPerThread) as Array<{ event_json: string }>;

    for (const row of rows) {
      const parsed = JSON.parse(row.event_json) as unknown;
      if (!isCodexMonitorEvent(parsed)) continue;
      this.applyEventToSnapshotCache(parsed);
    }
    this.snapshotCacheHydrated = true;
  }

  private applyEventToSnapshotCache(event: CodexMonitorEvent): void {
    const key = snapshotKey(event);
    const events = this.snapshotEvents.get(key);
    if (events) {
      events.push(event);
      this.snapshots.set(key, reduceSnapshot(events));
      return;
    }
    this.snapshotEvents.set(key, [event]);
    this.snapshots.set(key, reduceSnapshot([event]));
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

  enqueueCommand(command: {
    id: string;
    hostId: string;
    threadId?: string;
    cwd?: string;
    prompt: string;
    at: string;
  }): void {
    this.db
      .prepare(
        `
        INSERT INTO remote_commands
          (id, host_id, thread_id, cwd, prompt, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'queued', ?, ?)
      `,
      )
      .run(
        command.id,
        command.hostId,
        command.threadId ?? null,
        command.cwd ?? null,
        command.prompt,
        command.at,
        command.at,
      );
  }

  claimQueuedCommands(hostId: string, limit = 5, leaseMs = 5 * 60_000): RemoteCommandRecord[] {
    const now = new Date();
    const nowIso = now.toISOString();
    const leaseExpiresAt = new Date(now.getTime() + leaseMs).toISOString();
    const claimable = this.db
      .prepare(
        `
        SELECT id, host_id, thread_id, cwd, prompt, status, claimed_at, lease_expires_at,
          attempts, created_at, updated_at
        FROM remote_commands
        WHERE host_id = ?
          AND (
            status = 'queued'
            OR (status = 'in_progress' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?)
          )
        ORDER BY created_at ASC
        LIMIT ?
      `,
      )
      .all(hostId, nowIso, limit) as CommandRow[];

    const claim = this.db.prepare(
      `
      UPDATE remote_commands
      SET status = 'in_progress',
        claimed_at = ?,
        lease_expires_at = ?,
        attempts = attempts + 1,
        updated_at = ?
      WHERE id = ?
        AND (
          status = 'queued'
          OR (status = 'in_progress' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?)
        )
    `,
    );
    const read = this.db.prepare(
      `
      SELECT id, host_id, thread_id, cwd, prompt, status, claimed_at, lease_expires_at,
        attempts, created_at, updated_at
      FROM remote_commands
      WHERE id = ?
    `,
    );

    const claimedRows = this.db.transaction((rows: CommandRow[]) => {
      const claimed: CommandRow[] = [];
      for (const row of rows) {
        const result = claim.run(nowIso, leaseExpiresAt, nowIso, row.id, nowIso);
        if (result.changes === 1) {
          claimed.push(read.get(row.id) as CommandRow);
        }
      }
      return claimed;
    })(claimable);

    return claimedRows.map(commandRowToRecord);
  }

  private ensureRemoteCommandColumn(name: string, definition: string): void {
    const columns = this.db.prepare("PRAGMA table_info(remote_commands)").all() as Array<{
      name: string;
    }>;
    if (!columns.some((column) => column.name === name)) {
      this.db.exec(`ALTER TABLE remote_commands ADD COLUMN ${name} ${definition}`);
    }
  }

  private ensureEventColumn(name: string, definition: string): void {
    const columns = this.db.prepare("PRAGMA table_info(events)").all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === name)) {
      this.db.exec(`ALTER TABLE events ADD COLUMN ${name} ${definition}`);
    }
  }

  completeCommand(
    id: string,
    status: "completed" | "failed",
    summary: string | undefined,
  ): boolean {
    const result = this.db
      .prepare(
        `
        UPDATE remote_commands
        SET status = ?,
          summary = ?,
          lease_expires_at = NULL,
          updated_at = ?
        WHERE id = ? AND status IN ('queued', 'in_progress')
      `,
      )
      .run(status, summary ?? null, new Date().toISOString(), id);
    return result.changes > 0;
  }

  healthCheck(): void {
    this.db.prepare("SELECT 1").get();
  }

  close(): void {
    this.db.close();
  }
}

function normalizeStaleSnapshot(snapshot: ThreadSnapshot): ThreadSnapshot {
  if (snapshot.status !== "running" || snapshot.pendingApproval) return snapshot;
  const staleMs = staleRunningThreadMs();
  if (staleMs <= 0) return snapshot;
  const lastEventMs = Date.parse(snapshot.lastEventAt);
  if (!Number.isFinite(lastEventMs) || Date.now() - lastEventMs <= staleMs) return snapshot;
  return {
    ...snapshot,
    status: "idle",
    currentTurnId: undefined,
    steps: snapshot.steps.map((step) =>
      step.status === "running" ? { ...step, status: "completed" } : step,
    ),
  };
}

function visibleDesktopSnapshots(snapshots: ThreadSnapshot[]): ThreadSnapshot[] {
  const grouped = new Map<string, ThreadSnapshot[]>();
  for (const snapshot of snapshots) {
    const key = desktopProjectKey(snapshot);
    grouped.set(key, [...(grouped.get(key) ?? []), snapshot]);
  }

  return Array.from(grouped.values()).flatMap((projectSnapshots) => {
    const userSnapshots = projectSnapshots.filter((snapshot) => snapshot.threadSource === "user");
    if (userSnapshots.length > 0) return userSnapshots;
    return projectSnapshots.filter((snapshot) => snapshot.threadSource !== "subagent");
  });
}

function desktopProjectKey(snapshot: ThreadSnapshot): string {
  const cwd = snapshot.cwd?.trim().replace(/\/+$/g, "");
  return cwd || `uncategorized:${snapshot.hostId}`;
}

function staleRunningThreadMs(): number {
  const parsed = Number(process.env.STALE_RUNNING_THREAD_MS);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 2 * 60 * 60_000;
}

function boundedPositiveNumber(envName: string, fallback: number): number {
  const parsed = Number(process.env[envName]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function snapshotKey(event: CodexMonitorEvent): string {
  return `${event.hostId}\u0000${event.threadId}`;
}

function eventKey(event: CodexMonitorEvent): string {
  return createHash("sha256").update(JSON.stringify(event)).digest("hex");
}

interface CommandRow {
      id: string;
      host_id: string;
      thread_id: string | null;
      cwd: string | null;
      prompt: string;
      status: RemoteCommandRecord["status"];
      claimed_at: string | null;
      lease_expires_at: string | null;
      attempts: number;
      created_at: string;
      updated_at: string;
}

function commandRowToRecord(row: CommandRow): RemoteCommandRecord {
  return {
    id: row.id,
    hostId: row.host_id,
    threadId: row.thread_id ?? undefined,
    cwd: row.cwd ?? undefined,
    prompt: row.prompt,
    status: row.status,
    attempts: row.attempts,
    claimedAt: row.claimed_at ?? undefined,
    leaseExpiresAt: row.lease_expires_at ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
