export type StepStatus = "queued" | "running" | "completed" | "failed";
export type ThreadStatus =
  | "idle"
  | "running"
  | "waiting_for_approval"
  | "failed"
  | "completed";

export type CodexMonitorEvent =
  | {
      type: "thread.started";
      threadId: string;
      title: string;
      cwd?: string;
      threadSource?: string;
      at: string;
      hostId: string;
    }
  | {
      type: "turn.started";
      threadId: string;
      turnId: string;
      promptPreview: string;
      at: string;
      hostId: string;
    }
  | {
      type: "step.updated";
      threadId: string;
      turnId: string;
      stepId: string;
      label: string;
      status: StepStatus;
      at: string;
      hostId: string;
    }
  | {
      type: "log.appended";
      threadId: string;
      turnId: string;
      stream: "user" | "assistant" | "reasoning" | "tool" | "terminal" | "system";
      text: string;
      at: string;
      hostId: string;
    }
  | {
      type: "approval.requested";
      threadId: string;
      turnId: string;
      approvalId: string;
      commandPreview: string;
      at: string;
      hostId: string;
    }
  | {
      type: "turn.completed";
      threadId: string;
      turnId: string;
      outcome: "success" | "failed" | "cancelled";
      summary: string;
      at: string;
      hostId: string;
    };

export interface ThreadSnapshot {
  threadId: string;
  title: string;
  cwd?: string;
  threadSource?: string;
  hostId: string;
  status: ThreadStatus;
  currentTurnId?: string;
  lastEventAt: string;
  pendingApproval?: {
    approvalId: string;
    turnId: string;
    commandPreview: string;
    at: string;
  };
  steps: Array<{
    stepId: string;
    label: string;
    status: StepStatus;
  }>;
  recentLogs: Array<{
    stream: "user" | "assistant" | "reasoning" | "tool" | "terminal" | "system";
    text: string;
    at: string;
  }>;
}

const stepStatuses = ["queued", "running", "completed", "failed"];
const streams = ["user", "assistant", "reasoning", "tool", "terminal", "system"];
const outcomes = ["success", "failed", "cancelled"];

export function isCodexMonitorEvent(value: unknown): value is CodexMonitorEvent {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.type !== "string") return false;
  if (typeof candidate.threadId !== "string") return false;
  if (typeof candidate.at !== "string") return false;
  if (typeof candidate.hostId !== "string") return false;

  switch (candidate.type) {
    case "thread.started":
      return (
        typeof candidate.title === "string" &&
        (candidate.cwd === undefined || typeof candidate.cwd === "string") &&
        (candidate.threadSource === undefined || typeof candidate.threadSource === "string")
      );
    case "turn.started":
      return (
        typeof candidate.turnId === "string" &&
        typeof candidate.promptPreview === "string"
      );
    case "step.updated":
      return (
        typeof candidate.turnId === "string" &&
        typeof candidate.stepId === "string" &&
        typeof candidate.label === "string" &&
        stepStatuses.includes(String(candidate.status))
      );
    case "log.appended":
      return (
        typeof candidate.turnId === "string" &&
        streams.includes(String(candidate.stream)) &&
        typeof candidate.text === "string"
      );
    case "approval.requested":
      return (
        typeof candidate.turnId === "string" &&
        typeof candidate.approvalId === "string" &&
        typeof candidate.commandPreview === "string"
      );
    case "turn.completed":
      return (
        typeof candidate.turnId === "string" &&
        outcomes.includes(String(candidate.outcome)) &&
        typeof candidate.summary === "string"
      );
    default:
      return false;
  }
}

export function redactEvent(event: CodexMonitorEvent): CodexMonitorEvent {
  switch (event.type) {
    case "thread.started":
      return { ...event, title: redactText(event.title) };
    case "turn.started":
      return { ...event, promptPreview: redactText(event.promptPreview) };
    case "step.updated":
      return { ...event, label: redactText(event.label) };
    case "log.appended":
      return { ...event, text: redactText(event.text) };
    case "approval.requested":
      return { ...event, commandPreview: redactText(event.commandPreview) };
    case "turn.completed":
      return { ...event, summary: redactText(event.summary) };
  }
}

function redactText(text: string): string {
  return text
    .replace(/(OPENAI_API_KEY=)[^\s]+/g, "$1[REDACTED]")
    .replace(/(API_KEY=)[^\s]+/g, "$1[REDACTED]")
    .replace(/(Authorization:\s*Bearer\s+)[^\s'"]+/gi, "$1[REDACTED]");
}

export function reduceSnapshot(events: CodexMonitorEvent[]): ThreadSnapshot {
  if (events.length === 0) {
    throw new Error("Cannot reduce an empty event list");
  }

  const first = events[0];
  const steps = new Map<
    string,
    { stepId: string; label: string; status: StepStatus; turnId?: string }
  >();
  const logs: ThreadSnapshot["recentLogs"] = [];
  let title = first.type === "thread.started" ? first.title : first.threadId;
  let cwd = first.type === "thread.started" ? first.cwd : undefined;
  let threadSource = first.type === "thread.started" ? first.threadSource : undefined;
  let status: ThreadStatus = "idle";
  let currentTurnId: string | undefined;
  let lastEventAt = first.at;
  let pendingApproval: ThreadSnapshot["pendingApproval"];
  const terminalTurnIds = new Set<string>();

  for (const event of events) {
    lastEventAt = event.at;
    if (event.type === "thread.started") {
      title = event.title;
      cwd = event.cwd;
      threadSource = event.threadSource;
      if (currentTurnId && isSyntheticDesktopTurnId(first.threadId, currentTurnId)) {
        currentTurnId = undefined;
        status = "idle";
        pendingApproval = undefined;
      }
    }
    if (event.type === "turn.started") {
      if (terminalTurnIds.has(event.turnId)) {
        continue;
      }
      currentTurnId = event.turnId;
      status = "running";
      pendingApproval = undefined;
    }
    if (event.type === "step.updated") {
      steps.set(event.stepId, {
        stepId: event.stepId,
        label: event.label,
        status: event.status,
        turnId: event.turnId,
      });
      const clearedPendingApproval =
        pendingApproval && approvalMatchesStep(pendingApproval.approvalId, event.stepId);
      if (clearedPendingApproval) {
        pendingApproval = undefined;
      }
      if (terminalTurnIds.has(event.turnId)) {
        continue;
      }
      if (
        event.status === "queued" ||
        event.status === "running" ||
        Boolean(clearedPendingApproval)
      ) {
        currentTurnId = event.turnId;
        status = "running";
      }
    }
    if (event.type === "log.appended") {
      logs.push({ stream: event.stream, text: event.text, at: event.at });
    }
    if (event.type === "approval.requested") {
      currentTurnId = event.turnId;
      status = "waiting_for_approval";
      pendingApproval = {
        approvalId: event.approvalId,
        turnId: event.turnId,
        commandPreview: event.commandPreview,
        at: event.at,
      };
    }
    if (event.type === "turn.completed") {
      currentTurnId = event.turnId;
      pendingApproval = undefined;
      terminalTurnIds.add(event.turnId);
      for (const [stepId, step] of steps) {
        if (step.turnId === event.turnId && step.status === "running") {
          steps.set(stepId, {
            ...step,
            status: event.outcome === "success" ? "completed" : "failed",
          });
        }
      }
      status = event.outcome === "success" ? "completed" : "failed";
    }
  }

  return {
    threadId: first.threadId,
    title,
    cwd,
    threadSource,
    hostId: first.hostId,
    status,
    currentTurnId,
    lastEventAt,
    pendingApproval,
    steps: Array.from(steps.values()).map(({ turnId: _turnId, ...step }) => step),
    recentLogs: logs.slice(-snapshotRecentLogLimit()),
  };
}

function isSyntheticDesktopTurnId(threadId: string, turnId: string): boolean {
  return turnId.startsWith(`${threadId}-`) && /-\d{12,}$/.test(turnId);
}

function snapshotRecentLogLimit(): number {
  const value = Number(process.env.SNAPSHOT_RECENT_LOG_LIMIT ?? 2000);
  if (!Number.isFinite(value) || value <= 0) return 2000;
  return Math.floor(value);
}

function approvalMatchesStep(approvalId: string, stepId: string): boolean {
  return stepId === approvalId || stepId.endsWith(`-${approvalId}`);
}
