import Database from "better-sqlite3";
import {
  isCodexMonitorEvent,
  reduceSnapshot,
  type CodexMonitorEvent,
  type ThreadSnapshot,
} from "@codex-monitor/protocol";

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
      CREATE INDEX IF NOT EXISTS idx_events_created_at ON events(created_at);
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
      grouped.set(parsed.threadId, [...(grouped.get(parsed.threadId) ?? []), parsed]);
    }

    return Array.from(grouped.values()).map(reduceSnapshot);
  }

  close(): void {
    this.db.close();
  }
}
