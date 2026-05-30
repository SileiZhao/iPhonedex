import { execFileSync, spawn, spawnSync } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, readSync, statSync, writeFileSync } from "node:fs";
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
  rollout_path: string;
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

export interface BridgeState {
  lastLogId: number;
  emitted: string[];
  rolloutOffsets: Record<string, number>;
}

export interface RemoteCommand {
  id: string;
  hostId: string;
  kind?: "prompt" | "approval";
  threadId?: string;
  cwd?: string;
  prompt: string;
  approval?: {
    approvalId: string;
    action: "approve" | "reject";
    commandPreview?: string;
  };
  status: "queued" | "in_progress" | "completed" | "failed";
}

const defaultState: BridgeState = { lastLogId: 0, emitted: [], rolloutOffsets: {} };
const emittedLimit = 5000;
let remoteCommandRun: Promise<void> | undefined;

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
  const title = desktopThreadTitle(row);
  return [
    {
      type: "thread.started",
      threadId: row.id,
      title,
      cwd: row.cwd,
      threadSource: row.thread_source || undefined,
      at,
      hostId,
    },
    {
      type: "log.appended",
      threadId: row.id,
      turnId: `${row.id}-desktop-pulse`,
      stream: "system",
      text: `Codex Desktop activity in ${row.cwd}`.slice(0, 240),
      at,
      hostId,
    },
  ];
}

function desktopThreadTitle(row: Pick<CodexThreadRow, "id" | "title" | "preview">): string {
  const candidate =
    threadTitleOverride(row.id) ??
    sessionIndexThreadName(row.id) ??
    firstNonEmptyLine(row.title) ??
    firstNonEmptyLine(row.preview) ??
    row.id;
  return candidate.slice(0, 80);
}

function threadTitleOverride(threadId: string): string | undefined {
  const overrides = readThreadTitleOverrides();
  return firstNonEmptyLine(overrides[threadId] ?? "");
}

function readThreadTitleOverrides(): Record<string, string> {
  const inline = process.env.DESKTOP_BRIDGE_THREAD_TITLE_OVERRIDES;
  if (inline) return parseTitleOverrideJson(inline);

  const path = process.env.DESKTOP_BRIDGE_THREAD_TITLE_OVERRIDES_FILE
    ?? join(homedir(), ".codex", "codex-monitor-thread-titles.json");
  if (!existsSync(path)) return {};
  return parseTitleOverrideJson(readFileSync(path, "utf8"));
}

function sessionIndexThreadName(threadId: string): string | undefined {
  const names = readSessionIndexThreadNames();
  return firstNonEmptyLine(names[threadId] ?? "");
}

function readSessionIndexThreadNames(): Record<string, string> {
  const path =
    process.env.DESKTOP_BRIDGE_SESSION_INDEX_PATH ?? join(homedir(), ".codex", "session_index.jsonl");
  if (!existsSync(path)) return {};

  const names: Record<string, string> = {};
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const parsed = parseJsonObject(line);
    if (typeof parsed.id === "string" && typeof parsed.thread_name === "string") {
      const name = firstNonEmptyLine(parsed.thread_name);
      if (name) names[parsed.id] = name;
    }
  }
  return names;
}

function parseTitleOverrideJson(content: string): Record<string, string> {
  const parsed = parseJsonObject(content);
  const overrides: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value === "string" && value.trim()) {
      overrides[key] = value.trim();
    }
  }
  return overrides;
}

function firstNonEmptyLine(value: string): string | undefined {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
}

export function parseRolloutEvents(
  content: string,
  threadId: string,
  hostId: string,
): CodexMonitorEvent[] {
  const events: CodexMonitorEvent[] = [];
  const pendingUserMessages: Array<{ text: string; at: string }> = [];
  const assistantTexts = new Set<string>();
  const toolCalls = new Map<string, { turnId: string; label: string }>();
  let activeTurnId = "";

  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    const entry = parseJsonObject(line);
    const at = typeof entry.timestamp === "string" ? entry.timestamp : new Date().toISOString();
    const payload = objectValue(entry.payload);
    if (!payload) continue;

    if (entry.type === "turn_context") {
      activeTurnId = stringValue(payload.turn_id) ?? stringValue(payload.turnId) ?? activeTurnId;
      continue;
    }

    if (entry.type === "event_msg") {
      const eventType = stringValue(payload.type);
      if (eventType === "user_message") {
        const text = boundedText(stringValue(payload.message) ?? stringValue(payload.text));
        if (!text) continue;
        const turnId = stringValue(payload.turn_id) ?? stringValue(payload.turnId) ?? activeTurnId;
        if (!turnId) {
          pendingUserMessages.push({ text, at });
          continue;
        }
        events.push(logEvent(threadId, turnId, "user", text, at, hostId));
        continue;
      }

      if (eventType === "task_started") {
        activeTurnId =
          stringValue(payload.turn_id) ?? stringValue(payload.turnId) ?? activeTurnId;
        if (!activeTurnId) continue;
        const promptPreview = pendingUserMessages.at(-1)?.text ?? "";
        events.push({
          type: "turn.started",
          threadId,
          turnId: activeTurnId,
          promptPreview: promptPreview.slice(0, 240),
          at,
          hostId,
        });
        for (const message of pendingUserMessages.splice(0)) {
          events.push(logEvent(threadId, activeTurnId, "user", message.text, at, hostId));
        }
        continue;
      }

      if (eventType === "agent_message") {
        const text = boundedText(stringValue(payload.message) ?? stringValue(payload.text));
        if (!text || assistantTexts.has(text)) continue;
        assistantTexts.add(text);
        events.push(logEvent(threadId, activeTurnId || `${threadId}-unknown-turn`, "assistant", text, at, hostId));
        continue;
      }

      if (eventType === "task_complete") {
        const turnId = stringValue(payload.turn_id) ?? stringValue(payload.turnId) ?? activeTurnId;
        if (!turnId) continue;
        events.push({
          type: "turn.completed",
          threadId,
          turnId,
          outcome: "success",
          summary: "Codex turn completed",
          at,
          hostId,
        });
        activeTurnId = "";
        continue;
      }
    }

    if (entry.type === "response_item") {
      const turnId =
        stringValue(payload.turn_id) ??
        stringValue(payload.turnId) ??
        activeTurnId ??
        `${threadId}-unknown-turn`;
      const itemType = stringValue(payload.type);

      if (itemType === "reasoning") {
        const text = boundedText(reasoningText(payload));
        if (text) {
          events.push(logEvent(threadId, turnId, "reasoning", text, at, hostId));
        }
        continue;
      }

      if (itemType === "message" && stringValue(payload.role) === "assistant") {
        const text = boundedText(messageContentText(payload));
        if (!text || assistantTexts.has(text)) continue;
        assistantTexts.add(text);
        events.push(logEvent(threadId, turnId, "assistant", text, at, hostId));
        continue;
      }

      if (itemType === "function_call") {
        const callId = stringValue(payload.call_id) ?? stringValue(payload.callId);
        if (!callId) continue;
        const toolName = stringValue(payload.name) ?? "tool";
        const args = parseJsonObject(stringValue(payload.arguments) ?? "{}");
        const command = commandFromToolPayload(args);
        const label = `${toolName}: ${command || summarizeToolPayload(args)}`.slice(0, 120);
        const stepId = `codex-call-${callId}`;
        toolCalls.set(callId, { turnId, label });
        events.push({
          type: "step.updated",
          threadId,
          turnId,
          stepId,
          label,
          status: "running",
          at,
          hostId,
        });
        events.push(logEvent(threadId, turnId, "tool", label, at, hostId));
        continue;
      }

      if (itemType === "function_call_output") {
        const callId = stringValue(payload.call_id) ?? stringValue(payload.callId);
        if (!callId) continue;
        const toolCall = toolCalls.get(callId);
        const output = boundedText(stringValue(payload.output));
        if (toolCall) {
          events.push({
            type: "step.updated",
            threadId,
            turnId: toolCall.turnId,
            stepId: `codex-call-${callId}`,
            label: toolCall.label,
            status: functionCallOutputFailed(output) ? "failed" : "completed",
            at,
            hostId,
          });
        }
        if (output) {
          events.push(logEvent(threadId, toolCall?.turnId ?? turnId, "terminal", output, at, hostId));
        }
      }
    }
  }

  return events;
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

function functionCallOutputFailed(output: string): boolean {
  const exitCode = output.match(/(?:Process exited with code|Exit status:)\s*(-?\d+)/i);
  if (exitCode?.[1] && Number(exitCode[1]) !== 0) return true;
  return /\b(error|failed|exception|traceback)\b/i.test(output) &&
    !/\b0 failures?\b/i.test(output);
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
  if (
    response.status === 400 &&
    event.type === "log.appended" &&
    (event.stream === "user" || event.stream === "reasoning")
  ) {
    await upload({
      ...event,
      stream: "system",
      text: `[${event.stream}] ${event.text}`,
    });
    return;
  }
  if (!response.ok) {
    throw new Error(`Upload failed: ${response.status} ${await response.text()}`);
  }
}

async function uploadBatch(events: CodexMonitorEvent[]): Promise<void> {
  if (events.length === 0) return;
  if (events.length === 1) {
    await upload(events[0]);
    return;
  }

  const endpoint = requiredEnv("MONITOR_SERVER_URL").replace(/\/$/, "");
  const token = requiredEnv("RELAY_TOKEN");
  const response = await fetch(`${endpoint}/relay/events/batch`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ events: events.map(redactBeforeUpload) }),
  });
  if (response.status === 404) {
    for (const event of events) {
      await upload(event);
    }
    return;
  }
  if (!response.ok) {
    throw new Error(`Batch upload failed: ${response.status} ${await response.text()}`);
  }
}

async function fetchRemoteCommands(hostId: string): Promise<RemoteCommand[]> {
  const endpoint = requiredEnv("MONITOR_SERVER_URL").replace(/\/$/, "");
  const token = requiredEnv("RELAY_TOKEN");
  const url = new URL(`${endpoint}/relay/commands`);
  url.searchParams.set("hostId", hostId);
  const response = await fetch(url, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (response.status === 404) return [];
  if (!response.ok) {
    throw new Error(`Command poll failed: ${response.status} ${await response.text()}`);
  }
  const parsed = (await response.json()) as unknown;
  return Array.isArray(parsed) ? parsed.filter(isRemoteCommand) : [];
}

async function completeRemoteCommand(
  commandId: string,
  status: "completed" | "failed",
  summary: string,
): Promise<void> {
  const endpoint = requiredEnv("MONITOR_SERVER_URL").replace(/\/$/, "");
  const token = requiredEnv("RELAY_TOKEN");
  const response = await fetch(`${endpoint}/relay/commands/${commandId}/complete`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ status, summary: summary.slice(0, 4000) }),
  });
  if (!response.ok) {
    throw new Error(`Command completion failed: ${response.status} ${await response.text()}`);
  }
}

async function runRemoteCommands(hostId: string): Promise<void> {
  const commands = await fetchRemoteCommands(hostId);
  for (const command of commands) {
    await runRemoteCommand(command, hostId);
  }
}

function scheduleRemoteCommands(hostId: string): void {
  if (remoteCommandRun) return;
  remoteCommandRun = runRemoteCommands(hostId)
    .catch((error: unknown) => {
      console.error(error);
    })
    .finally(() => {
      remoteCommandRun = undefined;
    });
}

async function runRemoteCommand(command: RemoteCommand, hostId: string): Promise<void> {
  const threadId = command.threadId ?? `mobile-command-${command.id}`;
  const at = new Date().toISOString();
  await upload({
    type: "step.updated",
    threadId,
    turnId: command.id,
    stepId: `remote-command-${command.id}`,
    label: "Executing iPhone instruction on Mac",
    status: "running",
    at,
    hostId,
  });

  const result =
    command.kind === "approval"
      ? runCodexApprovalAction(command)
      : await executeCodexCommand(command);
  if (result.output) {
    await upload({
      type: "log.appended",
      threadId,
      turnId: command.id,
      stream: result.ok ? "assistant" : "system",
      text: result.output,
      at: new Date().toISOString(),
      hostId,
    });
  }

  await upload({
    type: "step.updated",
    threadId,
    turnId: command.id,
    stepId: `remote-command-${command.id}`,
    label: "Executing iPhone instruction on Mac",
    status: result.ok ? "completed" : "failed",
    at: new Date().toISOString(),
    hostId,
  });

  await upload({
    type: "turn.completed",
    threadId,
    turnId: command.id,
    outcome: result.ok ? "success" : "failed",
    summary: result.ok ? "iPhone instruction completed" : result.output || "iPhone instruction failed",
    at: new Date().toISOString(),
    hostId,
  });
  await completeRemoteCommand(
    command.id,
    result.ok ? "completed" : "failed",
    result.output || (result.ok ? "completed" : "failed"),
  );
  if (result.ok) {
    refreshCodexDesktopThread(threadId);
  }
}

async function executeCodexCommand(command: RemoteCommand): Promise<{ ok: boolean; output: string }> {
  if (command.cwd && !allowedCommandCwd(command.cwd)) {
    return { ok: false, output: "Remote command rejected: working directory is not allowed." };
  }
  const codexBin = resolveCodexBinary();
  const args = command.threadId
    ? ["exec", "resume", command.threadId, "-"]
    : ["exec", ...(command.cwd ? ["-C", command.cwd] : []), "-"];

  return new Promise((resolve) => {
    let output = "";
    const child = spawn(codexBin, args, {
      cwd: command.cwd || undefined,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
    }, Number(process.env.DESKTOP_BRIDGE_COMMAND_TIMEOUT_MS ?? 30 * 60_000));
    const append = (chunk: Buffer) => {
      output = `${output}${chunk.toString("utf8")}`.slice(-4000);
    };

    child.stdout.on("data", append);
    child.stderr.on("data", append);
    child.on("error", (error) => {
      clearTimeout(timeout);
      resolve({ ok: false, output: String(error.message || error).slice(-4000) });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timeout);
      const timedOut = signal === "SIGTERM";
      resolve({
        ok: code === 0 && !timedOut,
        output: (timedOut ? `${output}\nRemote command timed out.` : output).trim().slice(-4000),
      });
    });
    child.stdin.end(command.prompt);
  });
}

function resolveCodexBinary(): string {
  if (process.env.CODEX_BIN) return process.env.CODEX_BIN;
  const bundled = "/Applications/Codex.app/Contents/Resources/codex";
  return existsSync(bundled) ? bundled : "codex";
}

function allowedCommandCwd(cwd: string): boolean {
  const allowedRoots = (process.env.DESKTOP_BRIDGE_COMMAND_CWD_ALLOWLIST ?? "")
    .split(",")
    .map((value) => value.trim().replace(/\/+$/g, ""))
    .filter(Boolean);
  const normalized = cwd.replace(/\/+$/g, "");
  return allowedRoots.some((root) => normalized === root || normalized.startsWith(`${root}/`));
}

interface DesktopRefreshOptions {
  platform?: NodeJS.Platform;
  spawn?: (command: string, args: string[]) => { status: number | null; error?: Error };
}

interface DesktopApprovalOptions {
  platform?: NodeJS.Platform;
  spawn?: (command: string, args: string[]) => { status: number | null; error?: Error };
}

export function runCodexApprovalAction(
  command: RemoteCommand,
  options: DesktopApprovalOptions = {},
): { ok: boolean; output: string } {
  if ((options.platform ?? process.platform) !== "darwin") {
    return { ok: false, output: "Approval actions are only supported on macOS." };
  }
  if (!command.threadId) {
    return { ok: false, output: "Approval action is missing a target thread." };
  }
  const action = command.approval?.action;
  if (action !== "approve" && action !== "reject") {
    return { ok: false, output: "Approval action must be approve or reject." };
  }

  const labels = action === "approve" ? approvalButtonLabels() : rejectionButtonLabels();
  const targetUrl = `codex://threads/${command.threadId}`;
  const script = `
on run argv
  set bundleId to item 1 of argv
  set appPath to item 2 of argv
  set targetUrl to item 3 of argv
  set actionName to item 4 of argv
  set processName to item 5 of argv
  set buttonNames to my splitText(item 6 of argv, "||")
  my openCodexUrl(bundleId, appPath, targetUrl)
  delay 0.35
  tell application "System Events"
    repeat with attempt from 1 to 20
      try
        tell process processName
          set frontmost to true
          repeat with buttonName in buttonNames
            set matches to (buttons of entire contents of window 1 whose name is (buttonName as text))
            if (count of matches) > 0 then
              click item 1 of matches
              return "clicked " & buttonName
            end if
          end repeat
        end tell
      end try
      delay 0.2
    end repeat
  end tell
  error "Could not find " & actionName & " button in Codex. Grant Accessibility permission to the desktop bridge and keep the approval dialog visible."
end run
on openCodexUrl(bundleId, appPath, targetUrl)
  try
    do shell script "open -b " & quoted form of bundleId & " " & quoted form of targetUrl
  on error
    do shell script "open -a " & quoted form of appPath & " " & quoted form of targetUrl
  end try
end openCodexUrl
on splitText(theText, delimiter)
  set previousDelimiters to AppleScript's text item delimiters
  set AppleScript's text item delimiters to delimiter
  set parts to text items of theText
  set AppleScript's text item delimiters to previousDelimiters
  return parts
end splitText
`;
  const spawn = options.spawn ?? ((commandName, args) => spawnSync(commandName, args));
  const result = spawn("osascript", [
    "-e",
    script,
    process.env.DESKTOP_BRIDGE_CODEX_BUNDLE_ID ?? "com.openai.codex",
    process.env.DESKTOP_BRIDGE_CODEX_APP_PATH ?? "/Applications/Codex.app",
    targetUrl,
    action,
    process.env.DESKTOP_BRIDGE_CODEX_PROCESS_NAME ?? "Codex",
    labels.join("||"),
  ]);
  if (result.error) {
    return { ok: false, output: result.error.message };
  }
  if (result.status !== 0) {
    return {
      ok: false,
      output:
        "Could not click the Codex approval button. Grant Accessibility permission to the desktop bridge and keep the approval dialog visible.",
    };
  }
  return {
    ok: true,
    output:
      action === "approve"
        ? "Approved the pending Codex request from iPhone."
        : "Rejected the pending Codex request from iPhone.",
  };
}

function approvalButtonLabels(): string[] {
  return (process.env.DESKTOP_BRIDGE_APPROVE_BUTTON_LABELS ?? "")
    .split(",")
    .map((label) => label.trim())
    .filter(Boolean)
    .concat(["Approve", "Allow", "Run command", "Continue", "批准", "允许", "运行", "继续"]);
}

function rejectionButtonLabels(): string[] {
  return (process.env.DESKTOP_BRIDGE_REJECT_BUTTON_LABELS ?? "")
    .split(",")
    .map((label) => label.trim())
    .filter(Boolean)
    .concat(["Reject", "Deny", "Cancel", "拒绝", "取消"]);
}

export function refreshCodexDesktopThread(
  threadId: string | undefined,
  options: DesktopRefreshOptions = {},
): void {
  if (process.env.DESKTOP_BRIDGE_REFRESH_CODEX_APP === "false") return;
  if ((options.platform ?? process.platform) !== "darwin") return;

  const targetUrl = threadId ? `codex://threads/${threadId}` : "";
  const spawn = options.spawn ?? ((command, args) => spawnSync(command, args));
  const script = `
on run argv
  set bundleId to item 1 of argv
  set appPath to item 2 of argv
  set targetUrl to item 3 of argv
  my openCodexUrl(bundleId, appPath, "codex://settings")
  delay 0.18
  if targetUrl is not "" then
    my openCodexUrl(bundleId, appPath, targetUrl)
  else
    my openCodexUrl(bundleId, appPath, "")
  end if
end run
on openCodexUrl(bundleId, appPath, targetUrl)
  try
    if targetUrl is not "" then
      do shell script "open -b " & quoted form of bundleId & " " & quoted form of targetUrl
    else
      do shell script "open -b " & quoted form of bundleId
    end if
  on error
    if targetUrl is not "" then
      do shell script "open -a " & quoted form of appPath & " " & quoted form of targetUrl
    else
      do shell script "open -a " & quoted form of appPath
    end if
  end try
end openCodexUrl
`;
  const result = spawn("osascript", [
    "-e",
    script,
    process.env.DESKTOP_BRIDGE_CODEX_BUNDLE_ID ?? "com.openai.codex",
    process.env.DESKTOP_BRIDGE_CODEX_APP_PATH ?? "/Applications/Codex.app",
    targetUrl,
  ]);
  if (result.error || result.status !== 0) {
    // Desktop refresh is a best-effort UI nudge; command execution must not fail because of it.
  }
}

async function uploadNewEvents(events: CodexMonitorEvent[], state: BridgeState): Promise<void> {
  const emitted = new Set(state.emitted);
  let batch: CodexMonitorEvent[] = [];
  const flush = async () => {
    if (batch.length === 0) return;
    await uploadBatch(batch);
    batch = [];
  };

  for (const event of events) {
    const key = eventKey(event);
    if (emitted.has(key)) continue;
    batch.push(event);
    emitted.add(key);
    if (batch.length >= uploadBatchSize()) {
      await flush();
    }
  }
  await flush();
  state.emitted = Array.from(emitted).slice(-emittedLimit);
}

function uploadBatchSize(): number {
  const parsed = Number(process.env.DESKTOP_BRIDGE_UPLOAD_BATCH_SIZE ?? 25);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 25;
}

export function eventKey(event: CodexMonitorEvent): string {
  switch (event.type) {
    case "thread.started":
      return `${event.type}:${event.threadId}:${event.title}:${event.cwd ?? ""}:${event.threadSource ?? ""}:${event.at}`;
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

export function readRolloutIncrement(
  rolloutPath: string,
  threadId: string,
  state: BridgeState,
): string {
  const size = statSync(rolloutPath).size;
  const previousOffset = state.rolloutOffsets[threadId];
  const bootstrapBytes = Number(process.env.DESKTOP_BRIDGE_ROLLOUT_BOOTSTRAP_BYTES ?? 128 * 1024);
  const bootstrapping = previousOffset === undefined || previousOffset > size;
  const start =
    bootstrapping && bootstrapBytes > 0
      ? Math.max(0, size - bootstrapBytes)
      : bootstrapping
        ? 0
        : previousOffset;
  const content = readFileRange(rolloutPath, start, size);
  state.rolloutOffsets[threadId] = size;
  if (!bootstrapping || start === 0) return content;
  const firstNewline = content.indexOf("\n");
  return firstNewline >= 0 ? content.slice(firstNewline + 1) : "";
}

function readFileRange(path: string, start: number, end: number): string {
  const length = Math.max(0, end - start);
  if (length === 0) return "";
  const buffer = Buffer.alloc(length);
  const fd = openSync(path, "r");
  try {
    readSync(fd, buffer, 0, length, start);
  } finally {
    closeSync(fd);
  }
  return buffer.toString("utf8");
}

export function recentThreads(stateDbPath: string): CodexThreadRow[] {
  const since = Date.now() - Number(process.env.DESKTOP_BRIDGE_THREAD_WINDOW_MS ?? 24 * 3_600_000);
  return sqliteJson<CodexThreadRow>(
    stateDbPath,
    `
      SELECT id, title, preview, cwd, rollout_path, updated_at_ms, source, thread_source
      FROM threads
      WHERE archived = 0
        AND thread_source = 'user'
        AND source NOT LIKE '{"subagent":%'
        AND updated_at_ms >= ${since}
      ORDER BY updated_at_ms DESC
      LIMIT ${Number(process.env.DESKTOP_BRIDGE_THREAD_LIMIT ?? 20)}
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
    if (thread.rollout_path && existsSync(thread.rollout_path)) {
      const rolloutContent = readRolloutIncrement(thread.rollout_path, thread.id, state);
      if (rolloutContent) {
        events.push(...parseRolloutEvents(rolloutContent, thread.id, options.hostId));
      }
    }
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
  scheduleRemoteCommands(options.hostId);
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

function isRemoteCommand(value: unknown): value is RemoteCommand {
  const candidate = objectValue(value);
  const kind = candidate?.kind ?? "prompt";
  const approval = objectValue(candidate?.approval);
  return Boolean(
    candidate &&
      typeof candidate.id === "string" &&
      typeof candidate.hostId === "string" &&
      typeof candidate.prompt === "string" &&
      (kind === "prompt" || kind === "approval") &&
      (kind !== "approval" ||
        (approval &&
          typeof approval.approvalId === "string" &&
          (approval.action === "approve" || approval.action === "reject"))) &&
      (candidate.status === "queued" || candidate.status === "in_progress") &&
      (candidate.threadId === undefined || typeof candidate.threadId === "string") &&
      (candidate.cwd === undefined || typeof candidate.cwd === "string"),
  );
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function boundedText(value: string | undefined): string {
  return (value ?? "").replace(/\s+$/g, "").slice(0, 4000);
}

function logEvent(
  threadId: string,
  turnId: string,
  stream: "user" | "assistant" | "reasoning" | "tool" | "terminal" | "system",
  text: string,
  at: string,
  hostId: string,
): CodexMonitorEvent {
  return {
    type: "log.appended",
    threadId,
    turnId,
    stream,
    text,
    at,
    hostId,
  };
}

function reasoningText(payload: Record<string, unknown>): string | undefined {
  const summary = Array.isArray(payload.summary) ? payload.summary : [];
  const parts = summary
    .map((part) =>
      typeof part === "string" ? part : stringValue(objectValue(part)?.text),
    )
    .filter((part): part is string => Boolean(part));
  return parts.join("\n\n") || stringValue(payload.text);
}

function messageContentText(payload: Record<string, unknown>): string | undefined {
  const content = Array.isArray(payload.content) ? payload.content : [];
  const parts = content
    .map((part) =>
      typeof part === "string" ? part : stringValue(objectValue(part)?.text),
    )
    .filter((part): part is string => Boolean(part));
  return parts.join("\n\n") || stringValue(payload.text) || stringValue(payload.message);
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
