# Codex iPhone Monitoring 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 构建一个自托管系统，让 iPhone 可以实时监控 macOS 桌面版 Codex 的执行状态、进度、日志、任务完成和等待用户批准等状态。

**架构：** macOS 上运行一个本地 relay agent，连接 Codex App Server 或 Codex Hooks 获取事件，然后通过出站 WebSocket 推送到公网服务器。公网服务器作为独立后台服务运行在 `127.0.0.1:18787`，由现有 Nginx 以独立子域名或隔离路径反向代理，避免影响公司官网；iPhone 使用独立原生 App 订阅服务器事件并展示状态。

**技术栈：** Node.js 22、TypeScript、pnpm workspace、Fastify、WebSocket、SQLite、Swift 5.10、SwiftUI、XCTest、XcodeGen、Vitest。

---

## 设计边界

本计划默认不使用官方 Remote connections，因为该能力绑定 ChatGPT 账号/workspace，不适合作为第三方 API key 或 API 中转场景的通用方案。

本系统只做“监控”和“只读状态展示”。第一版不实现手机端远程批准命令、不远程输入消息、不执行 Mac 端控制操作。这样可以显著降低安全风险；后续若要增加控制能力，应单独写第二阶段计划。

Mac 端不开放任何入站公网端口。relay agent 只通过出站连接访问公网服务器。公网服务器永远不能直接访问 Codex App Server。

iPhone 端必须是独立安装的 iOS App，不使用 PWA、网页添加到主屏幕或嵌入公司官网页面。第一版通过 Xcode 直接安装到自用设备；若需要分发给多人，后续使用 TestFlight 或企业签名。

公网服务器已经承载公司官网，因此 Codex Monitor 必须与官网环境隔离：独立进程、独立端口、独立数据目录、独立环境变量、独立 Nginx location/server block。禁止改动现有官网应用进程、官网依赖、官网监听端口和官网静态资源目录。

## 外部参考

- Codex App Server: https://developers.openai.com/codex/app-server
- Codex Hooks: https://developers.openai.com/codex/hooks
- Codex Remote connections: https://developers.openai.com/codex/remote-connections
- Codex Authentication: https://developers.openai.com/codex/auth

## 文件结构

- 创建：`package.json`  
  定义 workspace、脚本和 Node 版本约束。

- 创建：`pnpm-workspace.yaml`  
  管理 `apps/*` 和 `packages/*`。

- 创建：`tsconfig.base.json`  
  共享 TypeScript 编译配置。

- 创建：`packages/protocol/src/index.ts`  
  定义 Mac relay、服务器、iPhone App 共享的事件类型、状态枚举和校验函数。

- 创建：`packages/protocol/src/index.test.ts`  
  覆盖事件校验、状态折叠、敏感字段过滤。

- 创建：`apps/server/src/server.ts`  
  Fastify 应用入口，提供 health check、relay WebSocket、mobile WebSocket 和 REST 查询 API。

- 创建：`apps/server/src/main.ts`  
  生产进程入口，读取 `HOST`、`PORT` 和 `DATABASE_URL` 并启动 HTTP 服务。

- 创建：`apps/server/src/auth.ts`  
  实现 relay token 和 mobile token 鉴权。

- 创建：`apps/server/src/store.ts`  
  SQLite 事件存储、线程快照读取和状态折叠。

- 创建：`apps/server/src/server.test.ts`  
  覆盖事件接收、未授权拒绝、移动端订阅和历史状态查询。

- 创建：`apps/relay/src/index.ts`  
  Mac relay agent 入口，读取本地 Codex 事件源并推送到公网服务器。

- 创建：`apps/relay/src/codex-source.ts`  
  抽象 Codex 事件来源。第一版实现 hooks stdin/jsonl 模式，并预留 app-server 模式接口。

- 创建：`apps/relay/src/redact.ts`  
  在离开 Mac 前过滤敏感内容。

- 创建：`apps/relay/src/index.test.ts`  
  覆盖断线重连、事件队列、脱敏和 token 配置。

- 创建：`apps/ios/project.yml`  
  XcodeGen 项目定义，生成独立 iOS App 工程。

- 创建：`apps/ios/CodexMonitor/App/CodexMonitorApp.swift`  
  原生 iOS App 入口。

- 创建：`apps/ios/CodexMonitor/Models/MonitorModels.swift`  
  Swift 端事件和线程快照模型。

- 创建：`apps/ios/CodexMonitor/Networking/MonitorClient.swift`  
  封装 REST 和 WebSocket 客户端。

- 创建：`apps/ios/CodexMonitor/Views/ContentView.swift`  
  iPhone 原生主界面：线程列表、当前线程状态、实时事件流。

- 创建：`apps/ios/CodexMonitorTests/MonitorClientTests.swift`  
  覆盖模型解码、断线状态、等待批准状态。

- 创建：`docs/deployment.md`  
  记录服务器隔离部署、Mac relay 启动、Codex hooks 配置和 iPhone App 配置方式。

---

## 事件模型

所有从 Mac 发往服务器的事件统一成 `CodexMonitorEvent`：

```ts
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
      status: "queued" | "running" | "completed" | "failed";
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
```

线程快照统一成 `ThreadSnapshot`：

```ts
export interface ThreadSnapshot {
  threadId: string;
  title: string;
  hostId: string;
  status: "idle" | "running" | "waiting_for_approval" | "failed" | "completed";
  currentTurnId?: string;
  lastEventAt: string;
  steps: Array<{
    stepId: string;
    label: string;
    status: "queued" | "running" | "completed" | "failed";
  }>;
  recentLogs: Array<{
    stream: "assistant" | "tool" | "terminal" | "system";
    text: string;
    at: string;
  }>;
}
```

---

## 任务 1：初始化 workspace

**文件：**
- 创建：`package.json`
- 创建：`pnpm-workspace.yaml`
- 创建：`tsconfig.base.json`

- [ ] **步骤 1：创建 package.json**

```json
{
  "name": "codex-iphone-monitor",
  "private": true,
  "type": "module",
  "packageManager": "pnpm@9.15.0",
  "engines": {
    "node": ">=22"
  },
  "scripts": {
    "build": "pnpm -r build",
    "test": "pnpm -r test",
    "lint": "pnpm -r lint",
    "dev:server": "pnpm --filter @codex-monitor/server dev",
    "dev:relay": "pnpm --filter @codex-monitor/relay dev",
    "ios:generate": "cd apps/ios && xcodegen generate",
    "ios:test": "xcodebuild test -project apps/ios/CodexMonitor.xcodeproj -scheme CodexMonitor -destination 'platform=iOS Simulator,name=iPhone 16'"
  },
  "devDependencies": {
    "@types/node": "^22.15.0",
    "typescript": "^5.8.3",
    "vitest": "^3.1.4"
  }
}
```

- [ ] **步骤 2：创建 pnpm-workspace.yaml**

```yaml
packages:
  - "apps/*"
  - "packages/*"
```

- [ ] **步骤 3：创建 tsconfig.base.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "declaration": true,
    "sourceMap": true
  }
}
```

- [ ] **步骤 4：安装依赖并验证 workspace**

运行：

```bash
pnpm install
pnpm test
```

预期：首次没有子包测试时，`pnpm test` 不应出现 TypeScript 或 workspace 配置错误。

- [ ] **步骤 5：Commit**

```bash
git add package.json pnpm-workspace.yaml tsconfig.base.json pnpm-lock.yaml
git commit -m "chore: initialize monitor workspace"
```

---

## 任务 2：实现共享协议包

**文件：**
- 创建：`packages/protocol/package.json`
- 创建：`packages/protocol/tsconfig.json`
- 创建：`packages/protocol/src/index.ts`
- 创建：`packages/protocol/src/index.test.ts`

- [ ] **步骤 1：创建失败测试**

```ts
import { describe, expect, it } from "vitest";
import {
  isCodexMonitorEvent,
  redactEvent,
  reduceSnapshot,
  type CodexMonitorEvent,
} from "./index.js";

describe("protocol", () => {
  it("validates monitor events", () => {
    const event: CodexMonitorEvent = {
      type: "turn.started",
      threadId: "thread-1",
      turnId: "turn-1",
      promptPreview: "build the app",
      at: "2026-05-26T10:00:00.000Z",
      hostId: "mac-mini",
    };

    expect(isCodexMonitorEvent(event)).toBe(true);
    expect(isCodexMonitorEvent({ type: "turn.started" })).toBe(false);
  });

  it("redacts secret-looking log text", () => {
    const event: CodexMonitorEvent = {
      type: "log.appended",
      threadId: "thread-1",
      turnId: "turn-1",
      stream: "terminal",
      text: "OPENAI_API_KEY=sk-live-secret-token",
      at: "2026-05-26T10:00:00.000Z",
      hostId: "mac-mini",
    };

    expect(redactEvent(event)).toMatchObject({
      text: "OPENAI_API_KEY=[REDACTED]",
    });
  });

  it("reduces events into a thread snapshot", () => {
    const events: CodexMonitorEvent[] = [
      {
        type: "thread.started",
        threadId: "thread-1",
        title: "iPhone monitor",
        at: "2026-05-26T10:00:00.000Z",
        hostId: "mac-mini",
      },
      {
        type: "turn.started",
        threadId: "thread-1",
        turnId: "turn-1",
        promptPreview: "ship it",
        at: "2026-05-26T10:01:00.000Z",
        hostId: "mac-mini",
      },
      {
        type: "approval.requested",
        threadId: "thread-1",
        turnId: "turn-1",
        approvalId: "approval-1",
        commandPreview: "pnpm install",
        at: "2026-05-26T10:02:00.000Z",
        hostId: "mac-mini",
      },
    ];

    expect(reduceSnapshot(events)).toMatchObject({
      threadId: "thread-1",
      status: "waiting_for_approval",
      currentTurnId: "turn-1",
    });
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：

```bash
pnpm --filter @codex-monitor/protocol test
```

预期：FAIL，提示找不到 `isCodexMonitorEvent`、`redactEvent`、`reduceSnapshot`。

- [ ] **步骤 3：实现协议包**

```ts
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
        ["queued", "running", "completed", "failed"].includes(
          String(candidate.status),
        )
      );
    case "log.appended":
      return (
        typeof candidate.turnId === "string" &&
        ["assistant", "tool", "terminal", "system"].includes(
          String(candidate.stream),
        ) &&
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
        ["success", "failed", "cancelled"].includes(String(candidate.outcome)) &&
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
  const steps = new Map<string, { stepId: string; label: string; status: StepStatus }>();
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
```

- [ ] **步骤 4：运行测试验证通过**

运行：

```bash
pnpm --filter @codex-monitor/protocol test
```

预期：PASS。

- [ ] **步骤 5：Commit**

```bash
git add packages/protocol
git commit -m "feat: add shared monitor protocol"
```

---

## 任务 3：实现公网服务器事件接入和订阅

**文件：**
- 创建：`apps/server/package.json`
- 创建：`apps/server/tsconfig.json`
- 创建：`apps/server/src/auth.ts`
- 创建：`apps/server/src/store.ts`
- 创建：`apps/server/src/server.ts`
- 创建：`apps/server/src/main.ts`
- 创建：`apps/server/src/server.test.ts`

- [ ] **步骤 1：创建失败测试**

测试必须覆盖：

```ts
import { afterEach, describe, expect, it } from "vitest";
import { buildServer } from "./server.js";

describe("server", () => {
  afterEach(() => {
    delete process.env.RELAY_TOKEN;
    delete process.env.MOBILE_TOKEN;
  });

  it("rejects relay websocket without token", async () => {
    process.env.RELAY_TOKEN = "relay-secret";
    process.env.MOBILE_TOKEN = "mobile-secret";
    const app = await buildServer({ databaseUrl: ":memory:" });

    const response = await app.inject({
      method: "GET",
      url: "/health",
    });

    expect(response.statusCode).toBe(200);
    await app.close();
  });

  it("stores events and returns thread snapshots", async () => {
    process.env.RELAY_TOKEN = "relay-secret";
    process.env.MOBILE_TOKEN = "mobile-secret";
    const app = await buildServer({ databaseUrl: ":memory:" });

    await app.inject({
      method: "POST",
      url: "/relay/events",
      headers: { authorization: "Bearer relay-secret" },
      payload: {
        type: "thread.started",
        threadId: "thread-1",
        title: "Monitor",
        at: "2026-05-26T10:00:00.000Z",
        hostId: "mac-mini",
      },
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/threads",
      headers: { authorization: "Bearer mobile-secret" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject([
      { threadId: "thread-1", title: "Monitor", status: "idle" },
    ]);

    await app.close();
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：

```bash
pnpm --filter @codex-monitor/server test
```

预期：FAIL，提示 `buildServer` 不存在。

- [ ] **步骤 3：实现鉴权**

`apps/server/src/auth.ts`：

```ts
import type { FastifyRequest } from "fastify";

export function requireBearer(request: FastifyRequest, expectedToken: string): void {
  const authorization = request.headers.authorization;
  if (authorization !== `Bearer ${expectedToken}`) {
    throw Object.assign(new Error("Unauthorized"), { statusCode: 401 });
  }
}

export function getRequiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}
```

- [ ] **步骤 4：实现存储**

`apps/server/src/store.ts` 使用 SQLite 表：

```sql
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
```

实现接口：

```ts
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
      const parsed = JSON.parse(row.event_json);
      if (!isCodexMonitorEvent(parsed)) continue;
      grouped.set(parsed.threadId, [...(grouped.get(parsed.threadId) ?? []), parsed]);
    }

    return Array.from(grouped.values()).map(reduceSnapshot);
  }

  close(): void {
    this.db.close();
  }
}
```

- [ ] **步骤 5：实现服务器入口**

`apps/server/src/server.ts`：

```ts
import fastify from "fastify";
import websocket from "@fastify/websocket";
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

export async function buildServer(options: BuildOptions) {
  const app = fastify({ logger: true });
  const store = new EventStore(options.databaseUrl);
  const mobileClients = new Set<{ send: (payload: string) => void }>();

  await app.register(websocket);

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

  app.get("/api/live", { websocket: true }, (connection, request) => {
    requireBearer(request, getRequiredEnv("MOBILE_TOKEN"));
    const client = { send: (payload: string) => connection.socket.send(payload) };
    mobileClients.add(client);
    connection.socket.on("close", () => {
      mobileClients.delete(client);
    });
  });

  return app;
}
```

- [ ] **步骤 6：实现生产进程入口**

`apps/server/src/main.ts`：

```ts
import { buildServer } from "./server.js";

const host = process.env.HOST ?? "127.0.0.1";
const port = Number(process.env.PORT ?? "8787");
const databaseUrl = process.env.DATABASE_URL ?? "/var/lib/codex-monitor/events.sqlite";

const app = await buildServer({ databaseUrl });

await app.listen({ host, port });
```

生产部署时，Docker 容器内监听 `0.0.0.0:8787`，宿主机只映射到 `127.0.0.1:18787`；非 Docker 部署直接监听 `127.0.0.1:18787`。

- [ ] **步骤 7：运行测试验证通过**

运行：

```bash
pnpm --filter @codex-monitor/server test
```

预期：PASS。

- [ ] **步骤 8：Commit**

```bash
git add apps/server
git commit -m "feat: add monitor server"
```

---

## 任务 4：实现 Mac relay agent

**文件：**
- 创建：`apps/relay/package.json`
- 创建：`apps/relay/tsconfig.json`
- 创建：`apps/relay/src/codex-source.ts`
- 创建：`apps/relay/src/redact.ts`
- 创建：`apps/relay/src/index.ts`
- 创建：`apps/relay/src/index.test.ts`

- [ ] **步骤 1：创建失败测试**

测试必须覆盖：

```ts
import { describe, expect, it } from "vitest";
import { parseHookLine } from "./codex-source.js";
import { redactBeforeUpload } from "./redact.js";

describe("relay", () => {
  it("parses codex hook json lines into monitor events", () => {
    const event = parseHookLine(
      JSON.stringify({
        hook_event_name: "TurnStart",
        session_id: "thread-1",
        prompt: "implement monitor",
        timestamp: "2026-05-26T10:00:00.000Z",
      }),
      "mac-mini",
    );

    expect(event).toMatchObject({
      type: "turn.started",
      threadId: "thread-1",
      turnId: "thread-1-2026-05-26T10:00:00.000Z",
      hostId: "mac-mini",
    });
  });

  it("redacts secrets before upload", () => {
    const event = redactBeforeUpload({
      type: "log.appended",
      threadId: "thread-1",
      turnId: "turn-1",
      stream: "terminal",
      text: "Authorization: Bearer secret",
      at: "2026-05-26T10:00:00.000Z",
      hostId: "mac-mini",
    });

    expect(event).toMatchObject({
      text: "Authorization: Bearer [REDACTED]",
    });
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：

```bash
pnpm --filter @codex-monitor/relay test
```

预期：FAIL，提示 `parseHookLine` 和 `redactBeforeUpload` 不存在。

- [ ] **步骤 3：实现 hooks jsonl 解析**

`apps/relay/src/codex-source.ts`：

```ts
import type { CodexMonitorEvent } from "@codex-monitor/protocol";

interface RawHookEvent {
  hook_event_name?: string;
  session_id?: string;
  prompt?: string;
  message?: string;
  command?: string;
  timestamp?: string;
}

export function parseHookLine(line: string, hostId: string): CodexMonitorEvent | null {
  const raw = JSON.parse(line) as RawHookEvent;
  const at = raw.timestamp ?? new Date().toISOString();
  const threadId = raw.session_id ?? "unknown-thread";
  const turnId = `${threadId}-${at}`;

  if (raw.hook_event_name === "TurnStart") {
    return {
      type: "turn.started",
      threadId,
      turnId,
      promptPreview: (raw.prompt ?? "").slice(0, 240),
      at,
      hostId,
    };
  }

  if (raw.hook_event_name === "Notification") {
    return {
      type: "log.appended",
      threadId,
      turnId,
      stream: "system",
      text: raw.message ?? "Codex notification",
      at,
      hostId,
    };
  }

  if (raw.hook_event_name === "UserPromptSubmit") {
    return {
      type: "thread.started",
      threadId,
      title: (raw.prompt ?? threadId).slice(0, 80),
      at,
      hostId,
    };
  }

  return null;
}
```

- [ ] **步骤 4：实现脱敏**

`apps/relay/src/redact.ts`：

```ts
import { redactEvent, type CodexMonitorEvent } from "@codex-monitor/protocol";

export function redactBeforeUpload(event: CodexMonitorEvent): CodexMonitorEvent {
  return redactEvent(event);
}
```

- [ ] **步骤 5：实现 relay 入口**

`apps/relay/src/index.ts`：

```ts
import readline from "node:readline";
import { stdin } from "node:process";
import { parseHookLine } from "./codex-source.js";
import { redactBeforeUpload } from "./redact.js";

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

async function upload(event: unknown): Promise<void> {
  const endpoint = requiredEnv("MONITOR_SERVER_URL");
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

export async function run(): Promise<void> {
  const hostId = process.env.HOST_ID ?? "mac";
  const reader = readline.createInterface({ input: stdin });

  for await (const line of reader) {
    const parsed = parseHookLine(line, hostId);
    if (!parsed) continue;
    await upload(redactBeforeUpload(parsed));
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
```

- [ ] **步骤 6：运行测试验证通过**

运行：

```bash
pnpm --filter @codex-monitor/relay test
```

预期：PASS。

- [ ] **步骤 7：Commit**

```bash
git add apps/relay
git commit -m "feat: add mac relay agent"
```

---

## 任务 5：实现独立 iPhone App

**文件：**
- 创建：`apps/ios/project.yml`
- 创建：`apps/ios/CodexMonitor/App/CodexMonitorApp.swift`
- 创建：`apps/ios/CodexMonitor/Models/MonitorModels.swift`
- 创建：`apps/ios/CodexMonitor/Networking/MonitorClient.swift`
- 创建：`apps/ios/CodexMonitor/Views/ContentView.swift`
- 创建：`apps/ios/CodexMonitorTests/MonitorModelsTests.swift`
- 创建：`apps/ios/CodexMonitorTests/MonitorClientTests.swift`

- [ ] **步骤 1：创建失败测试**

`apps/ios/CodexMonitorTests/MonitorModelsTests.swift`：

```swift
import XCTest
@testable import CodexMonitor

final class MonitorModelsTests: XCTestCase {
    func testDecodesWaitingForApprovalSnapshot() throws {
        let json = """
        {
          "threadId": "thread-1",
          "title": "Monitor",
          "hostId": "mac-mini",
          "status": "waiting_for_approval",
          "currentTurnId": "turn-1",
          "lastEventAt": "2026-05-26T10:00:00.000Z",
          "steps": [],
          "recentLogs": [
            { "stream": "system", "text": "Need approval", "at": "2026-05-26T10:00:00.000Z" }
          ]
        }
        """.data(using: .utf8)!

        let snapshot = try JSONDecoder().decode(ThreadSnapshot.self, from: json)

        XCTAssertEqual(snapshot.title, "Monitor")
        XCTAssertEqual(snapshot.status, .waitingForApproval)
        XCTAssertEqual(snapshot.statusLabel, "等待批准")
        XCTAssertEqual(snapshot.recentLogs.first?.text, "Need approval")
    }
}
```

`apps/ios/CodexMonitorTests/MonitorClientTests.swift`：

```swift
import XCTest
@testable import CodexMonitor

final class MonitorClientTests: XCTestCase {
    func testBuildsAuthenticatedRequests() throws {
        let client = MonitorClient(
            baseURL: URL(string: "https://monitor.example.com")!,
            token: "mobile-secret"
        )

        let request = client.makeRequest(path: "/api/threads")

        XCTAssertEqual(request.url?.absoluteString, "https://monitor.example.com/api/threads")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer mobile-secret")
    }
}
```

- [ ] **步骤 2：运行测试验证失败**

运行：

```bash
xcodegen generate --spec apps/ios/project.yml
xcodebuild test -project apps/ios/CodexMonitor.xcodeproj -scheme CodexMonitor -destination 'platform=iOS Simulator,name=iPhone 16'
```

预期：FAIL，提示 `ThreadSnapshot`、`MonitorClient` 或 Xcode project 不存在。

- [ ] **步骤 3：创建 XcodeGen 项目配置**

`apps/ios/project.yml`：

```yaml
name: CodexMonitor
options:
  bundleIdPrefix: com.codexmonitor
  deploymentTarget:
    iOS: "17.0"
settings:
  base:
    SWIFT_VERSION: "5.10"
targets:
  CodexMonitor:
    type: application
    platform: iOS
    sources:
      - CodexMonitor
    settings:
      base:
        PRODUCT_BUNDLE_IDENTIFIER: com.codexmonitor.app
        INFOPLIST_KEY_CFBundleDisplayName: Codex Monitor
        INFOPLIST_KEY_UIApplicationSceneManifest_Generation: YES
        INFOPLIST_KEY_UIApplicationSupportsIndirectInputEvents: YES
        INFOPLIST_KEY_UILaunchScreen_Generation: YES
    info:
      path: CodexMonitor/Info.plist
      properties:
        NSAppTransportSecurity:
          NSAllowsArbitraryLoads: false
  CodexMonitorTests:
    type: bundle.unit-test
    platform: iOS
    sources:
      - CodexMonitorTests
    dependencies:
      - target: CodexMonitor
```

- [ ] **步骤 4：实现 Swift 模型**

`apps/ios/CodexMonitor/Models/MonitorModels.swift`：

```swift
import Foundation

enum ThreadStatus: String, Codable {
    case idle
    case running
    case waitingForApproval = "waiting_for_approval"
    case failed
    case completed

    var statusLabel: String {
        switch self {
        case .idle: return "空闲"
        case .running: return "执行中"
        case .waitingForApproval: return "等待批准"
        case .failed: return "失败"
        case .completed: return "已完成"
        }
    }
}

struct StepSnapshot: Codable, Identifiable, Equatable {
    let stepId: String
    let label: String
    let status: String

    var id: String { stepId }
}

struct LogLine: Codable, Identifiable, Equatable {
    let stream: String
    let text: String
    let at: String

    var id: String { "\(at)-\(stream)-\(text.hashValue)" }
}

struct ThreadSnapshot: Codable, Identifiable, Equatable {
    let threadId: String
    let title: String
    let hostId: String
    let status: ThreadStatus
    let currentTurnId: String?
    let lastEventAt: String
    let steps: [StepSnapshot]
    let recentLogs: [LogLine]

    var id: String { threadId }
    var statusLabel: String { status.statusLabel }
}
```

- [ ] **步骤 5：实现 iOS API 客户端**

`apps/ios/CodexMonitor/Networking/MonitorClient.swift`：

```swift
import Foundation

final class MonitorClient {
    private let baseURL: URL
    private let token: String
    private let session: URLSession

    init(baseURL: URL, token: String, session: URLSession = .shared) {
        self.baseURL = baseURL
        self.token = token
        self.session = session
    }

    func makeRequest(path: String) -> URLRequest {
        var request = URLRequest(url: baseURL.appending(path: path))
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.timeoutInterval = 20
        return request
    }

    func fetchThreads() async throws -> [ThreadSnapshot] {
        let request = makeRequest(path: "/api/threads")
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            throw URLError(.badServerResponse)
        }
        return try JSONDecoder().decode([ThreadSnapshot].self, from: data)
    }

    func makeLiveSocket() -> URLSessionWebSocketTask {
        var components = URLComponents(url: baseURL.appending(path: "/api/live"), resolvingAgainstBaseURL: false)!
        components.scheme = baseURL.scheme == "https" ? "wss" : "ws"
        var request = URLRequest(url: components.url!)
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        return session.webSocketTask(with: request)
    }
}
```

- [ ] **步骤 6：实现 SwiftUI 界面**

`apps/ios/CodexMonitor/App/CodexMonitorApp.swift`：

```swift
import SwiftUI

@main
struct CodexMonitorApp: App {
    var body: some Scene {
        WindowGroup {
            ContentView()
        }
    }
}
```

`apps/ios/CodexMonitor/Views/ContentView.swift`：

```swift
import SwiftUI

@MainActor
final class MonitorViewModel: ObservableObject {
    @Published var baseURLText = "https://monitor.example.com"
    @Published var token = ""
    @Published var connected = false
    @Published var snapshots: [ThreadSnapshot] = []
    @Published var errorMessage: String?

    func refresh() async {
        guard let url = URL(string: baseURLText), !token.isEmpty else {
            errorMessage = "请填写服务器地址和 mobile token"
            return
        }

        do {
            snapshots = try await MonitorClient(baseURL: url, token: token).fetchThreads()
            connected = true
            errorMessage = nil
        } catch {
            connected = false
            errorMessage = error.localizedDescription
        }
    }
}

struct ContentView: View {
    @StateObject private var viewModel = MonitorViewModel()

    var body: some View {
        NavigationStack {
            List {
                Section("连接") {
                    TextField("https://monitor.example.com", text: $viewModel.baseURLText)
                        .textInputAutocapitalization(.never)
                        .keyboardType(.URL)
                    SecureField("mobile token", text: $viewModel.token)
                    Button("刷新状态") {
                        Task { await viewModel.refresh() }
                    }
                    Text(viewModel.connected ? "实时连接" : "连接断开")
                        .foregroundStyle(viewModel.connected ? .green : .red)
                }

                if let errorMessage = viewModel.errorMessage {
                    Section("错误") {
                        Text(errorMessage).foregroundStyle(.red)
                    }
                }

                Section("Codex 任务") {
                    ForEach(viewModel.snapshots) { snapshot in
                        VStack(alignment: .leading, spacing: 8) {
                            HStack {
                                Text(snapshot.title).font(.headline)
                                Spacer()
                                Text(snapshot.statusLabel).font(.subheadline).bold()
                            }
                            Text(snapshot.hostId).font(.caption).foregroundStyle(.secondary)
                            ForEach(snapshot.recentLogs.prefix(8)) { log in
                                Text("[\(log.stream)] \(log.text)")
                                    .font(.system(.caption, design: .monospaced))
                                    .lineLimit(3)
                            }
                        }
                        .padding(.vertical, 6)
                    }
                }
            }
            .navigationTitle("Codex Monitor")
            .task { await viewModel.refresh() }
        }
    }
}
```

界面要求：
- 独立 iOS App，不使用网页壳、PWA 或公司官网页面。
- iPhone 竖屏优先，320px 到 430px 宽度不溢出。
- 状态标签颜色区分：执行中蓝色、等待批准橙色、失败红色、完成绿色。
- 日志区域使用等宽字体，长日志截断并可进入详情页查看完整内容。
- 第一版允许手动输入服务器地址和 mobile token；后续再做扫码配置。

- [ ] **步骤 7：运行测试验证通过**

运行：

```bash
xcodegen generate --spec apps/ios/project.yml
xcodebuild test -project apps/ios/CodexMonitor.xcodeproj -scheme CodexMonitor -destination 'platform=iOS Simulator,name=iPhone 16'
```

预期：PASS。

- [ ] **步骤 8：用 iOS Simulator 验证界面**

运行：

```bash
xcodebuild -project apps/ios/CodexMonitor.xcodeproj -scheme CodexMonitor -destination 'platform=iOS Simulator,name=iPhone 16' build
```

用 iPhone 16 Simulator 启动 App，验证：
- 顶部状态不遮挡列表。
- 长日志文本不撑破页面。
- 等待批准状态醒目。
- 断线状态可见。
- 不访问公司官网页面，不依赖 Safari 添加到主屏幕。

- [ ] **步骤 9：Commit**

```bash
git add apps/ios
git commit -m "feat: add native iphone monitor app"
```

---

## 任务 6：公网服务器隔离部署和运行文档

**文件：**
- 创建：`docs/deployment.md`
- 创建：`deploy/docker-compose.codex-monitor.yml`
- 创建：`deploy/nginx/codex-monitor-subdomain.conf`
- 创建：`deploy/nginx/codex-monitor-path.conf`
- 创建：`deploy/systemd/codex-monitor.service`

- [ ] **步骤 1：写隔离部署原则**

`docs/deployment.md` 必须写明：
- 公司官网继续使用原有进程、原有端口、原有站点目录。
- Codex Monitor 服务只监听 `127.0.0.1:18787`，不占用 `80`、`443`、官网应用端口或官网静态目录。
- Codex Monitor 使用独立 Linux 用户 `codex-monitor`、独立目录 `/opt/codex-monitor`、独立数据目录 `/var/lib/codex-monitor`、独立日志目录 `/var/log/codex-monitor`。
- 优先使用独立子域名 `monitor.example.com`；如果暂时不能加 DNS，再使用同域名路径 `/codex-monitor/`。
- 只新增 Nginx server block 或 location block，不改动官网 upstream、root、proxy_pass 和证书续期任务。

- [ ] **步骤 2：写 Docker Compose 隔离运行配置**

`deploy/docker-compose.codex-monitor.yml`：

```yaml
services:
  codex-monitor:
    image: node:22-alpine
    working_dir: /app
    command: ["node", "apps/server/dist/main.js"]
    restart: unless-stopped
    user: "10001:10001"
    environment:
      NODE_ENV: production
      HOST: 0.0.0.0
      PORT: "8787"
      DATABASE_URL: /data/events.sqlite
      RELAY_TOKEN: ${RELAY_TOKEN}
      MOBILE_TOKEN: ${MOBILE_TOKEN}
    ports:
      - "127.0.0.1:18787:8787"
    volumes:
      - /opt/codex-monitor/app:/app:ro
      - /var/lib/codex-monitor:/data
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "5"
```

运行方式：

```bash
sudo mkdir -p /opt/codex-monitor/app /var/lib/codex-monitor
sudo chown -R 10001:10001 /var/lib/codex-monitor
RELAY_TOKEN="$(openssl rand -hex 32)"
MOBILE_TOKEN="$(openssl rand -hex 32)"
printf 'RELAY_TOKEN=%s\nMOBILE_TOKEN=%s\n' "$RELAY_TOKEN" "$MOBILE_TOKEN" | sudo tee /opt/codex-monitor/.env
docker compose --env-file /opt/codex-monitor/.env -f deploy/docker-compose.codex-monitor.yml up -d
```

- [ ] **步骤 3：写非 Docker systemd 备选配置**

`deploy/systemd/codex-monitor.service`：

```ini
[Unit]
Description=Codex Monitor API
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=codex-monitor
Group=codex-monitor
WorkingDirectory=/opt/codex-monitor/app
EnvironmentFile=/opt/codex-monitor/codex-monitor.env
ExecStart=/usr/bin/node apps/server/dist/main.js
Restart=always
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true
ProtectHome=true
ReadWritePaths=/var/lib/codex-monitor

[Install]
WantedBy=multi-user.target
```

`/opt/codex-monitor/codex-monitor.env`：

```bash
NODE_ENV=production
HOST=127.0.0.1
PORT=18787
DATABASE_URL=/var/lib/codex-monitor/events.sqlite
RELAY_TOKEN=server-generated-relay-token
MOBILE_TOKEN=server-generated-mobile-token
```

- [ ] **步骤 4：写子域名 Nginx 配置**

`deploy/nginx/codex-monitor-subdomain.conf`：

```nginx
server {
  listen 443 ssl http2;
  server_name monitor.example.com;

  location / {
    proxy_pass http://127.0.0.1:18787;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
  }
}
```

该文件是新增站点配置，不能覆盖公司官网的 Nginx 配置文件。

- [ ] **步骤 5：写同域路径 Nginx 备选配置**

`deploy/nginx/codex-monitor-path.conf`：

```nginx
location /codex-monitor/ {
  proxy_pass http://127.0.0.1:18787/;
  proxy_http_version 1.1;
  proxy_set_header Host $host;
  proxy_set_header X-Forwarded-Proto $scheme;
  proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  proxy_set_header Upgrade $http_upgrade;
  proxy_set_header Connection "upgrade";
}
```

使用路径模式时，iPhone App 的服务器地址填写 `https://example.com/codex-monitor`。Nginx 通过 `proxy_pass http://127.0.0.1:18787/;` 去掉 `/codex-monitor/` 前缀，后端服务仍然只处理 `/health`、`/api/threads` 和 `/api/live`。

- [ ] **步骤 6：写部署前冲突检查命令**

文档包含：

```bash
sudo ss -lntp | grep -E ':80|:443|:18787'
sudo nginx -T | grep -n "monitor.example.com\\|codex-monitor"
docker ps --format 'table {{.Names}}\t{{.Ports}}'
```

预期：
- `80` 和 `443` 仍由 Nginx 占用。
- `18787` 只绑定 `127.0.0.1`。
- 不出现官网容器或官网进程端口变化。

- [ ] **步骤 7：写 Mac relay 环境变量**

文档包含：

```bash
export MONITOR_SERVER_URL="https://monitor.example.com"
export RELAY_TOKEN="server-generated-relay-token"
export HOST_ID="$(hostname)"
```

- [ ] **步骤 8：写 Codex hooks 接入方式**

文档说明第一版接入方式：
- 配置 Codex hooks，把 hook JSON 通过 stdin 传给 `pnpm --filter @codex-monitor/relay start`。
- 如果 hooks 输出字段与本计划假设字段不同，先调整 `apps/relay/src/codex-source.ts` 的 `RawHookEvent` 映射，并补对应测试。
- 不在 hooks 中传完整 secret、完整 `.env`、完整终端历史。

- [ ] **步骤 9：写 iPhone App 配置方式**

文档包含：

```bash
xcodegen generate --spec apps/ios/project.yml
open apps/ios/CodexMonitor.xcodeproj
```

在 iPhone App 首屏填写：
- Server URL: `https://monitor.example.com`
- Mobile Token: `/opt/codex-monitor/.env` 中的 `MOBILE_TOKEN`

- [ ] **步骤 10：写官网无影响验证**

```bash
curl -I https://example.com/
curl -I https://monitor.example.com/health
curl -H "Authorization: Bearer $MOBILE_TOKEN" https://monitor.example.com/api/threads
```

预期：
- 公司官网首页返回原有状态码和响应头。
- `monitor.example.com/health` 返回 `200`。
- `/api/threads` 在 token 正确时返回 JSON 数组。

- [ ] **步骤 11：Commit**

```bash
git add docs/deployment.md deploy
git commit -m "docs: add isolated deployment guide"
```

---

## 任务 7：端到端验证

**文件：**
- 修改：`apps/server/src/server.test.ts`
- 修改：`apps/ios/CodexMonitorTests/MonitorModelsTests.swift`
- 修改：`apps/ios/CodexMonitorTests/MonitorClientTests.swift`
- 创建：`apps/e2e/package.json`
- 创建：`apps/e2e/tests/server-isolation.test.ts`

- [ ] **步骤 1：补 server 事件广播测试**

增加测试：
- mobile client 连接 `/api/live` 后，relay 上传事件。
- mobile client 收到同一个事件。
- 未授权 mobile client 被拒绝。

- [ ] **步骤 2：补 iOS 模型和客户端测试**

增加测试：
- `ThreadSnapshot.status == .waitingForApproval` 时显示“等待批准”。
- `MonitorClient.makeLiveSocket()` 使用 `wss://`。
- `MonitorClient.makeRequest(path:)` 带 `Authorization: Bearer <token>`。

- [ ] **步骤 3：创建服务器隔离 E2E**

场景：
1. 启动 server，监听 `127.0.0.1:18787`。
2. 用 HTTP POST 模拟 Mac relay 上传 `thread.started`、`turn.started`、`approval.requested`。
3. 用 mobile token 查询 `/api/threads`。
4. 断言返回 `waiting_for_approval`。
5. 执行 `curl -I https://example.com/` 的 smoke check；在 CI 中没有真实官网时，用本地 Nginx fixture 模拟官网 server block，断言官网 upstream 未被 monitor 配置覆盖。

- [ ] **步骤 4：运行全量验证**

运行：

```bash
pnpm test
pnpm build
xcodegen generate --spec apps/ios/project.yml
xcodebuild test -project apps/ios/CodexMonitor.xcodeproj -scheme CodexMonitor -destination 'platform=iOS Simulator,name=iPhone 16'
pnpm --filter @codex-monitor/e2e test
```

预期：全部 PASS。

- [ ] **步骤 5：Commit**

```bash
git add apps/server apps/ios apps/e2e
git commit -m "test: add monitor end-to-end coverage"
```

---

## 安全要求

- relay token 和 mobile token 必须不同。
- relay token 只存在 Mac 和服务器环境变量中。
- mobile token 第一版可手动配置，生产版本应替换为短期登录 session。
- 所有公网访问必须走 HTTPS。
- Mac relay 只出站连接服务器，不监听公网端口。
- Codex Monitor 后端只监听 `127.0.0.1:18787` 或 Docker 内部端口映射，不直接占用 `80`、`443` 或官网应用端口。
- iPhone 端必须是原生 App；不把监控 UI 挂到公司官网页面，也不复用官网前端构建产物。
- 上传前在 Mac relay 侧脱敏，服务器侧再次脱敏。
- 日志默认只保留最近 100 条；生产部署应增加保留周期，例如 7 天后自动删除。
- 第一版不允许手机远程批准命令。

## 里程碑

### M1：只读状态链路

完成任务 1 到任务 4。可以从 Mac 上传事件，服务器能存储和查询。

### M2：iPhone 可视化

完成任务 5。独立 iPhone App 能看到实时状态和历史状态。

### M3：可部署版本

完成任务 6 和任务 7。具备部署文档、测试覆盖和端到端验证。

## 自检

- 规格覆盖度：方案覆盖 Mac 桌面版 Codex 状态采集、公网服务器中转、独立 iPhone App 实时查看、第三方 API key 场景下不依赖官方 Remote connections，并明确公网服务器与现有公司官网隔离部署。
- 占位符扫描：本文未使用“待定”“后续实现”作为实现步骤；所有阶段都有明确文件、代码或验证命令。
- 类型一致性：`CodexMonitorEvent`、`ThreadSnapshot`、`reduceSnapshot` 在协议包、服务器和移动端中保持同名同签名。
