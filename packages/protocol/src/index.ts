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
      stream: "assistant" | "tool" | "terminal" | "system";
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
  hostId: string;
  status: ThreadStatus;
  currentTurnId?: string;
  lastEventAt: string;
  steps: Array<{
    stepId: string;
    label: string;
    status: StepStatus;
  }>;
  recentLogs: Array<{
    stream: "assistant" | "tool" | "terminal" | "system";
    text: string;
    at: string;
  }>;
}

const stepStatuses = ["queued", "running", "completed", "failed"];
const streams = ["assistant", "tool", "terminal", "system"];
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
      return typeof candidate.title === "string";
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
  if (event.type !== "log.appended") return event;
  return {
    ...event,
    text: event.text
      .replace(/(OPENAI_API_KEY=)[^\s]+/g, "$1[REDACTED]")
      .replace(/(API_KEY=)[^\s]+/g, "$1[REDACTED]")
      .replace(/(Authorization:\s*Bearer\s+)[^\s]+/gi, "$1[REDACTED]"),
  };
}

export function reduceSnapshot(events: CodexMonitorEvent[]): ThreadSnapshot {
  if (events.length === 0) {
    throw new Error("Cannot reduce an empty event list");
  }

  const first = events[0];
  const steps = new Map<
    string,
    { stepId: string; label: string; status: StepStatus }
  >();
  const logs: ThreadSnapshot["recentLogs"] = [];
  let title = first.type === "thread.started" ? first.title : first.threadId;
  let status: ThreadStatus = "idle";
  let currentTurnId: string | undefined;
  let lastEventAt = first.at;

  for (const event of events) {
    lastEventAt = event.at;
    if (event.type === "thread.started") {
      title = event.title;
      status = "idle";
    }
    if (event.type === "turn.started") {
      currentTurnId = event.turnId;
      status = "running";
    }
    if (event.type === "step.updated") {
      steps.set(event.stepId, {
        stepId: event.stepId,
        label: event.label,
        status: event.status,
      });
      if (event.status === "failed") status = "failed";
    }
    if (event.type === "log.appended") {
      logs.push({ stream: event.stream, text: event.text, at: event.at });
    }
    if (event.type === "approval.requested") {
      currentTurnId = event.turnId;
      status = "waiting_for_approval";
    }
    if (event.type === "turn.completed") {
      currentTurnId = event.turnId;
      status = event.outcome === "success" ? "completed" : "failed";
    }
  }

  return {
    threadId: first.threadId,
    title,
    hostId: first.hostId,
    status,
    currentTurnId,
    lastEventAt,
    steps: Array.from(steps.values()),
    recentLogs: logs.slice(-100),
  };
}
