# Codex Monitor 部署指南

本服务用于把 Mac 上的 Codex 执行状态同步到独立 iPhone App。公网服务器已经运行公司官网，因此 Codex Monitor 必须作为隔离服务部署。

## 隔离原则

- 公司官网继续使用原有进程、原有端口、原有站点目录。
- Codex Monitor 只监听 `127.0.0.1:18787`，不占用 `80`、`443`、官网应用端口或官网静态目录。
- Codex Monitor 使用独立 Linux 用户 `codex-monitor`、独立目录 `/opt/codex-monitor`、独立数据目录 `/var/lib/codex-monitor`、独立日志目录 `/var/log/codex-monitor`。
- 优先使用独立子域名 `monitor.example.com`；如果暂时不能加 DNS，再使用同域名路径 `/codex-monitor/`。
- 只新增 Nginx server block 或 location block，不改动官网 upstream、root、proxy_pass 和证书续期任务。

## 构建服务端

在构建机或服务器上执行：

```bash
pnpm install
pnpm --filter @codex-monitor/server build
pnpm --filter @codex-monitor/relay build
```

把仓库构建产物同步到 `/opt/codex-monitor/app`。如果使用 Docker Compose，容器会以只读方式挂载该目录。

## 本地真机联调

本地 smoke 脚本会在 Mac 上用内存数据库启动 server，并写入一条 `thread.started` 和一条 `approval.requested` 测试事件，方便 iPhone 真机页面直接看到任务状态。

```bash
scripts/local-smoke.sh start
scripts/local-smoke.sh status
```

`start` 会创建 macOS LaunchAgent，让 smoke server 在后台持续运行；`status` 会打印当前 iPhone 可用的 Server URL、Mobile Token 和测试任务快照。脚本启动参数固定为本地联调用途：`HOST=0.0.0.0 PORT=8787 DATABASE_URL=:memory: RELAY_TOKEN=relay-secret MOBILE_TOKEN=mobile-secret`。启动后在 iPhone App 首屏填写：

- Server URL: `http://<Mac局域网IP>:8787`
- Mobile Token: `mobile-secret`

联调结束后停止后台服务：

```bash
scripts/local-smoke.sh stop
```

该配置只用于 Mac 与 iPhone 在同一局域网内的本地联调，不要用于公网或生产部署。

## Docker Compose 部署

生成 token：

```bash
RELAY_TOKEN="$(openssl rand -hex 32)"
MOBILE_TOKEN="$(openssl rand -hex 32)"
sudo mkdir -p /opt/codex-monitor/app /opt/codex-monitor/secrets /var/lib/codex-monitor
sudo chown -R 10001:10001 /var/lib/codex-monitor
sudo cp AuthKey_<apns-key-id>.p8 /opt/codex-monitor/secrets/AuthKey_<apns-key-id>.p8
sudo chmod 0400 /opt/codex-monitor/secrets/AuthKey_<apns-key-id>.p8
sudo chown -R 10001:10001 /opt/codex-monitor/secrets
printf 'RELAY_TOKEN=%s\nMOBILE_TOKEN=%s\nAPNS_KEY_ID=<apns-key-id>\nAPNS_TEAM_ID=<apns-team-id>\nAPNS_TOPIC=<ios-bundle-id>\n' "$RELAY_TOKEN" "$MOBILE_TOKEN" | sudo tee /opt/codex-monitor/.env
```

启动：

```bash
docker compose --env-file /opt/codex-monitor/.env -f deploy/docker-compose.codex-monitor.yml up -d
```

验证监听：

```bash
sudo ss -lntp | grep -E ':80|:443|:18787'
docker ps --format 'table {{.Names}}\t{{.Ports}}'
```

预期：`80` 和 `443` 仍由 Nginx 占用；`18787` 只绑定 `127.0.0.1`；公司官网容器或进程端口没有变化。`/health` 会同时检查 API 进程和 SQLite 可读写连接，返回：

```json
{ "ok": true, "database": "ok" }
```

## systemd 备选部署

创建用户和目录：

```bash
sudo useradd --system --home /opt/codex-monitor --shell /usr/sbin/nologin codex-monitor
sudo mkdir -p /opt/codex-monitor/app /var/lib/codex-monitor /var/log/codex-monitor
sudo chown -R codex-monitor:codex-monitor /opt/codex-monitor /var/lib/codex-monitor /var/log/codex-monitor
```

写入环境变量：

```bash
sudo tee /opt/codex-monitor/codex-monitor.env >/dev/null <<EOF
NODE_ENV=production
HOST=127.0.0.1
PORT=18787
DATABASE_URL=/var/lib/codex-monitor/events.sqlite
RELAY_TOKEN=$(openssl rand -hex 32)
MOBILE_TOKEN=$(openssl rand -hex 32)
APNS_KEY_PATH=/opt/codex-monitor/secrets/AuthKey_<apns-key-id>.p8
APNS_KEY_ID=<apns-key-id>
APNS_TEAM_ID=<apns-team-id>
APNS_TOPIC=<ios-bundle-id>
EOF
```

安装 APNs 私钥：

```bash
sudo mkdir -p /opt/codex-monitor/secrets
sudo cp AuthKey_<apns-key-id>.p8 /opt/codex-monitor/secrets/AuthKey_<apns-key-id>.p8
sudo chown -R codex-monitor:codex-monitor /opt/codex-monitor/secrets
sudo chmod 0400 /opt/codex-monitor/secrets/AuthKey_<apns-key-id>.p8
```

安装服务：

```bash
sudo cp deploy/systemd/codex-monitor.service /etc/systemd/system/codex-monitor.service
sudo systemctl daemon-reload
sudo systemctl enable --now codex-monitor
sudo systemctl status codex-monitor
```

## Nginx 子域名方式

推荐给 `monitor.example.com` 增加 DNS 记录，然后把 `deploy/nginx/codex-monitor-subdomain.conf` 作为新增站点配置安装。不要覆盖公司官网配置文件。

如果服务器已有官网证书和 Certbot 任务，不要复用或改写官网站点文件。先为监控子域名单独签发证书；模板默认使用 Certbot 的标准路径：

```bash
sudo certbot certonly --nginx -d monitor.example.com
```

如果你的证书路径不同，再把模板中的两行证书配置改成实际路径：

```nginx
ssl_certificate /etc/letsencrypt/live/monitor.example.com/fullchain.pem;
ssl_certificate_key /etc/letsencrypt/live/monitor.example.com/privkey.pem;
```

证书签发和 Nginx reload 前都先运行 `sudo nginx -t`，确认不会影响现有官网。

```bash
sudo cp deploy/nginx/codex-monitor-subdomain.conf /etc/nginx/sites-available/codex-monitor.conf
sudo ln -s /etc/nginx/sites-available/codex-monitor.conf /etc/nginx/sites-enabled/codex-monitor.conf
sudo nginx -t
sudo systemctl reload nginx
```

## Nginx 同域路径方式

如果暂时不能使用子域名，把 `deploy/nginx/codex-monitor-path.conf` 追加到官网 `server { ... }` 内。该配置只接管 `/codex-monitor/` 路径，并通过 `proxy_pass http://127.0.0.1:18787/;` 去掉路径前缀。

iPhone App 的服务器地址填写：

```text
https://example.com/codex-monitor
```

路径模板包含精确 `/codex-monitor` 到 `/codex-monitor/` 的 `308` 重定向，避免 iPhone 或浏览器少写尾部斜杠时命中官网 root。

路径方式验证：

```bash
curl -I https://example.com/
curl -I https://example.com/codex-monitor/health
curl -H "Authorization: Bearer $MOBILE_TOKEN" https://example.com/codex-monitor/api/threads
```

## Mac relay 配置

Mac 上配置环境变量：

```bash
export MONITOR_SERVER_URL="https://monitor.example.com"
export RELAY_TOKEN="server-generated-relay-token"
export HOST_ID="$(hostname)"
export RELAY_UPLOAD_ATTEMPTS=3
export RELAY_UPLOAD_RETRY_DELAY_MS=1000
```

Codex hooks 接入方式：

- 配置 Codex hooks，把每行 hook JSON 通过 stdin 传给 `pnpm --filter @codex-monitor/relay start` 或构建后的 `pnpm --filter @codex-monitor/relay start`。
- relay 识别 `SessionStart`、`UserPromptSubmit`、`PreToolUse`、`PermissionRequest`、`PostToolUse`、`Notification`、`Stop`，并优先使用 `session_id`、`turn_id`、`tool_call_id`、`tool_input.command`。
- `PermissionRequest` 会生成 iPhone 端的“等待批准”状态和命令预览；`PreToolUse` / `PostToolUse` 会生成步骤 timeline；`Notification` 会进入最近日志。
- `HOST_ID` 会写入每个事件，server 会按 `hostId + threadId` 分组，避免多台 Mac 的同名 session 合并。
- 上传失败会按 `RELAY_UPLOAD_ATTEMPTS` 和 `RELAY_UPLOAD_RETRY_DELAY_MS` 重试。长期断网时仍可能丢失 hook 事件；如要做到严格不丢，需要再加本地落盘队列。
- relay 和 server 都会对 `title`、`promptPreview`、`commandPreview`、`summary`、日志文本中的常见 API key 和 Bearer token 做脱敏。不要在 hooks 中传完整 `.env`、完整终端历史或无需监控的私密文件内容。
- 如果官方 hooks 字段继续变化，先调整 `apps/relay/src/codex-source.ts` 的 `RawHookEvent` 映射，并补测试。

### Codex Desktop bridge

如果 Codex Desktop 暂时没有稳定暴露 hooks，使用 Desktop bridge 作为本机真实状态接入。它读取 `~/.codex/state_5.sqlite` 与 `~/.codex/logs_2.sqlite`，只上传线程标题、工作目录、工具调用摘要和 turn 完成状态，不上传完整 prompt、完整模型响应或原始 SSE 日志。

安装：

```bash
MONITOR_SERVER_URL="https://example.com/codex-monitor" \
RELAY_TOKEN="server-generated-relay-token" \
scripts/install-codex-monitor-desktop-bridge.sh install
```

查看状态和日志：

```bash
scripts/install-codex-monitor-desktop-bridge.sh status
tail -f ~/Library/Logs/codex-monitor-desktop-bridge.err.log
```

停止：

```bash
scripts/install-codex-monitor-desktop-bridge.sh stop
```

Desktop bridge 会安装为独立 LaunchAgent `com.codexmonitor.desktop-bridge`，不会替换 `~/.codex/config.toml` 里已有的 `notify` 配置，因此不会影响 Codex Computer Use。

token 轮换：

```bash
NEW_MOBILE_TOKEN="$(openssl rand -hex 32)"
sudo sed -i.bak "s/^MOBILE_TOKEN=.*/MOBILE_TOKEN=$NEW_MOBILE_TOKEN/" /opt/codex-monitor/codex-monitor.env
sudo systemctl restart codex-monitor
```

轮换后在 iPhone App 设置里更新 `Mobile Token`，点“测试连接”再“连接并监控”。

## APNs 后台推送

后台推送使用 Apple token-based provider authentication。server 启动时读取以下环境变量；缺少任意一项时会退回 no-op provider，不影响状态同步：

```bash
APNS_KEY_PATH=/opt/codex-monitor/secrets/AuthKey_<apns-key-id>.p8
APNS_KEY_ID=<apns-key-id>
APNS_TEAM_ID=<apns-team-id>
APNS_TOPIC=<ios-bundle-id>
```

`.p8` 私钥只放在服务器 `/opt/codex-monitor/secrets/`，权限建议 `0400`，不要放入仓库、Docker 镜像或日志。Debug 真机安装拿到的是 sandbox device token；TestFlight/App Store 拿到的是 production device token。iPhone App 会在“连接并监控”成功后请求通知权限、注册 APNs，并把 device token 上传到：

```http
POST /api/devices/register
Authorization: Bearer <MOBILE_TOKEN>
Content-Type: application/json

{ "token": "<apns-device-token>", "environment": "sandbox" }
```

server 会把 token 持久化到 SQLite 的 `device_tokens` 表。收到 `approval.requested`、`step.updated failed` 或 `turn.completed failed` 时，server 会向已注册设备发送 APNs alert；APNs 发送失败不会阻断 `/relay/events` 入库和 WebSocket 广播。

## iPhone App 配置

生成 Xcode 工程：

```bash
xcodegen generate --spec apps/ios/project.yml
open apps/ios/CodexMonitor.xcodeproj
```

在 iPhone App 首屏填写：

- Server URL: `https://monitor.example.com`
- Mobile Token: `/opt/codex-monitor/.env` 或 `/opt/codex-monitor/codex-monitor.env` 中的 `MOBILE_TOKEN`

## 官网无影响验证

```bash
curl -I https://example.com/
curl -I https://monitor.example.com/health
curl -H "Authorization: Bearer $MOBILE_TOKEN" https://monitor.example.com/api/threads
```

预期：

- 公司官网首页返回原有状态码和响应头。
- `monitor.example.com/health` 返回 `200`。
- `/api/threads` 在 token 正确时返回 JSON 数组。
