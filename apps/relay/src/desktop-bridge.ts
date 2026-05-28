import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { CodexMonitorEvent } from "@codex-monitor/protocol";
import { redactBeforeUpload } from "./redact.js";

export interface CodexThreadRow {
  id: string;
  title: string;
  preview: string;
  cwd: string;
  updated_at_ms: number;
  source: string;
  thread_source: string;
}

export interface CodexLogRow {
  id: number;
  ts: number;
  ts_nanos: number;
  target: string;
  feedback_log_body: string;
  thread_id: string;
}

interface BridgeState {
  lastLogId: number;
  emitted: string[];
}

const defaultState: BridgeState = { lastLogId: 0, emitted: [] };
const emittedLimit = 1000;

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

function sqliteJson<T>(databasePath: string, sql: string): T[] {
  const output = execFileSync("sqlite3", ["-json", databasePath, sql], {
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
  }).trim();
  return output ? (JSON.parse(output) as T[]) : [];
}

export function eventAtFromLogRow(row: Pick<CodexLogRow, "ts" | "ts_nanos">): string {
  const milliseconds = row.ts * 1000 + Math.floor(row.ts_nanos / 1_000_000);
  return new Date(milliseconds).toISOString();
}

function eventAtFromThreadRow(row: Pick<CodexThreadRow, "updated_at_ms">): string {
  return new Date(row.updated_at_ms).toISOString();
}

export function buildThreadPulseEvents(
  row: CodexThreadRow,
  hostId: string,
): CodexMonitorEvent[] {
  const at = eventAtFromThreadRow(row);
  const title = (row.title || row.preview || row.id).slice(0, 80);
  const turnId = `${row.id}-${row.updated_at_ms}`;
  return [
    {
      type: "thread.started",
      threadId: row.id,
      title,
      at,
      hostId,
    },
    {
      type: "turn.started",
      threadId: row.id,
      turnId,
      promptPreview: (row.preview || title).slice(0, 240),
      at,
      hostId,
    },
    {
      type: "log.appended",
      threadId: row.id,
      turnId,
      stream: "system",
      text: `Codex Desktop activity in ${row.cwd}`.slice(0, 240),
      at,
      hostId,
    },
  ];
}

export function parseToolCallLog(row: CodexLogRow, hostId: string): CodexMonitorEvent[] {
  if (row.target !== "codex_core::stream_events_utils") return [];
  if (!row.feedback_log_body.includes("ToolCall:")) return [];

  const match = row.feedback_log_body.match(/ToolCall:\s+([A-Za-z0-9_.:-]+)\s+(\{.*\})/s);
  if (!match) return [];

  const toolName = match[1] ?? "tool";
  const payload = parseJsonObject(match[2] ?? "{}");
  const command = commandFromToolPayload(payload);
  const at = eventAtFromLogRow(row);
  const turnId = extractTurnId(row.feedback_log_body) ?? `${row.thread_id}-${row.id}`;
  const label = `${toolName}: ${command || summarizeToolPayload(payload)}`.slice(0, 120);

  return [
    {
      type: "step.updated",
      threadId: row.thread_id,
      turnId,
      stepId: `codex-log-${row.id}`,
      label,
      status: "running",
      at,
      hostId,
    },
    {
      type: "log.appended",
      threadId: row.thread_id,
      turnId,
      stream: "system",
      text: label,
      at,
      hostId,
    },
  ];
}

export function parseTurnCompletedLog(row: CodexLogRow, hostId: string): CodexMonitorEvent[] {
  if (!row.feedback_log_body.includes("post sampling token usage")) return [];
  const turnId = extractTurnId(row.feedback_log_body);
  if (!turnId) return [];
  return [
    {
      type: "turn.completed",
      threadId: row.thread_id,
      turnId,
      outcome: "success",
      summary: "Codex turn completed",
      at: eventAtFromLogRow(row),
      hostId,
    },
  ];
}

async function upload(event: CodexMonitorEvent): Promise<void> {
  const endpoint = requiredEnv("MONITOR_SERVER_URL").replace(/\/$/, "");
  const token = requiredEnv("RELAY_TOKEN");
  const response = await fetch(`${endpoint}/relay/events`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(redactBeforeUpload(event)),
  });
  if (!response.ok) {
    throw new Error(`Upload failed: ${response.status} ${await response.text()}`);
  }
}

async function uploadNewEvents(events: CodexMonitorEvent[], state: BridgeState): Promise<void> {
  const emitted = new Set(state.emitted);
  for (const event of events) {
    const key = eventKey(event);
    if (emitted.has(key)) continue;
    await upload(event);
    emitted.add(key);
  }
  state.emitted = Array.from(emitted).slice(-emittedLimit);
}

function eventKey(event: CodexMonitorEvent): string {
  switch (event.type) {
    case "thread.started":
      return `${event.type}:${event.threadId}:${event.at}`;
    case "turn.started":
      return `${event.type}:${event.threadId}:${event.turnId}:${event.at}`;
    case "step.updated":
      return `${event.type}:${event.threadId}:${event.stepId}:${event.status}`;
    case "log.appended":
      return `${event.type}:${event.threadId}:${event.turnId}:${event.text}:${event.at}`;
    case "approval.requested":
      return `${event.type}:${event.threadId}:${event.approvalId}:${event.at}`;
    case "turn.completed":
      return `${event.type}:${event.threadId}:${event.turnId}:${event.at}`;
  }
}

function readState(path: string): BridgeState {
  if (!existsSync(path)) return { ...defaultState };
  try {
    return { ...defaultState, ...(JSON.parse(readFileSync(path, "utf8")) as BridgeState) };
  } catch {
    return { ...defaultState };
  }
}

function writeState(path: string, state: BridgeState): void {
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
}

function recentThreads(stateDbPath: string): CodexThreadRow[] {
  const since = Date.now() - Number(process.env.DESKTOP_BRIDGE_THREAD_WINDOW_MS ?? 3_600_000);
  return sqliteJson<CodexThreadRow>(
    stateDbPath,
    `
      SELECT id, title, preview, cwd, updated_at_ms, source, thread_source
      FROM threads
      WHERE archived = 0
        AND updated_at_ms >= ${since}
        AND thread_source != 'subagent'
      ORDER BY updated_at_ms DESC
      LIMIT ${Number(process.env.DESKTOP_BRIDGE_THREAD_LIMIT ?? 5)}
    `,
  );
}

function newLogs(
  logsDbPath: string,
  lastLogId: number,
  allowedThreadIds: string[],
): CodexLogRow[] {
  const sinceSeconds =
    Math.floor(Date.now() / 1000) -
    Number(process.env.DESKTOP_BRIDGE_LOG_WINDOW_SECONDS ?? 3600);
  const threadFilter = allowedThreadIds.length
    ? `AND thread_id IN (${allowedThreadIds.map(sqlStringLiteral).join(", ")})`
    : "";
  return sqliteJson<CodexLogRow>(
    logsDbPath,
    `
      SELECT id, ts, ts_nanos, target, substr(feedback_log_body, 1, 4000) AS feedback_log_body, thread_id
      FROM logs
      WHERE id > ${lastLogId}
        AND ts >= ${sinceSeconds}
        AND thread_id IS NOT NULL
        AND feedback_log_body IS NOT NULL
        ${threadFilter}
        AND (
          feedback_log_body LIKE '%ToolCall:%'
          OR feedback_log_body LIKE '%post sampling token usage%'
        )
      ORDER BY id ASC
      LIMIT ${Number(process.env.DESKTOP_BRIDGE_LOG_LIMIT ?? 200)}
    `,
  );
}

function sqlStringLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

async function tick(options: {
  stateDbPath: string;
  logsDbPath: string;
  statePath: string;
  hostId: string;
}): Promise<void> {
  const state = readState(options.statePath);
  const events: CodexMonitorEvent[] = [];

  const threads = recentThreads(options.stateDbPath);
  for (const thread of threads) {
    events.push(...buildThreadPulseEvents(thread, options.hostId));
  }

  const rows = newLogs(
    options.logsDbPath,
    state.lastLogId,
    threads.map((thread) => thread.id),
  );
  for (const row of rows) {
    state.lastLogId = Math.max(state.lastLogId, row.id);
    events.push(...parseToolCallLog(row, options.hostId));
    events.push(...parseTurnCompletedLog(row, options.hostId));
  }

  await uploadNewEvents(events, state);
  writeState(options.statePath, state);
}

function parseJsonObject(text: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function commandFromToolPayload(payload: Record<string, unknown>): string | undefined {
  for (const key of ["cmd", "command", "recipient_name", "session_id"]) {
    const value = payload[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function summarizeToolPayload(payload: Record<string, unknown>): string {
  const keys = Object.keys(payload);
  return keys.length ? keys.slice(0, 3).join(", ") : "tool call";
}

function extractTurnId(text: string): string | undefined {
  return (
    text.match(/turn\.id=([A-Za-z0-9_-]+)/)?.[1] ??
    text.match(/turn_id=([A-Za-z0-9_-]+)/)?.[1]
  );
}

export async function runDesktopBridge(): Promise<void> {
  const codexHome = process.env.CODEX_HOME ?? join(homedir(), ".codex");
  const stateDbPath = process.env.CODEX_STATE_DB ?? join(codexHome, "state_5.sqlite");
  const logsDbPath = process.env.CODEX_LOGS_DB ?? join(codexHome, "logs_2.sqlite");
  const statePath =
    process.env.DESKTOP_BRIDGE_STATE_PATH ?? join(codexHome, "codex-monitor-bridge-state.json");
  const hostId = process.env.HOST_ID ?? hostname();
  const intervalMs = Number(process.env.DESKTOP_BRIDGE_INTERVAL_MS ?? 3000);

  if (!existsSync(dirname(statePath))) {
    throw new Error(`State directory does not exist: ${dirname(statePath)}`);
  }

  for (;;) {
    try {
      await tick({ stateDbPath, logsDbPath, statePath, hostId });
    } catch (error) {
      console.error(error);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  runDesktopBridge().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}
