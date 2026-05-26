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
scripts/local-smoke.sh
```

脚本启动参数固定为本地联调用途：`HOST=0.0.0.0 PORT=8787 DATABASE_URL=:memory: RELAY_TOKEN=relay-secret MOBILE_TOKEN=mobile-secret`。启动后在 iPhone App 首屏填写：

- Server URL: `http://<Mac局域网IP>:8787`
- Mobile Token: `mobile-secret`

该配置只用于 Mac 与 iPhone 在同一局域网内的本地联调，不要用于公网或生产部署。

## Docker Compose 部署

生成 token：

```bash
RELAY_TOKEN="$(openssl rand -hex 32)"
MOBILE_TOKEN="$(openssl rand -hex 32)"
sudo mkdir -p /opt/codex-monitor/app /var/lib/codex-monitor
sudo chown -R 10001:10001 /var/lib/codex-monitor
printf 'RELAY_TOKEN=%s\nMOBILE_TOKEN=%s\n' "$RELAY_TOKEN" "$MOBILE_TOKEN" | sudo tee /opt/codex-monitor/.env
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

预期：`80` 和 `443` 仍由 Nginx 占用；`18787` 只绑定 `127.0.0.1`；公司官网容器或进程端口没有变化。

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
EOF
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

## Mac relay 配置

Mac 上配置环境变量：

```bash
export MONITOR_SERVER_URL="https://monitor.example.com"
export RELAY_TOKEN="server-generated-relay-token"
export HOST_ID="$(hostname)"
```

Codex hooks 第一版接入方式：

- 配置 Codex hooks，把 hook JSON 通过 stdin 传给 `pnpm --filter @codex-monitor/relay start`。
- 如果 hooks 输出字段与实现假设字段不同，先调整 `apps/relay/src/codex-source.ts` 的 `RawHookEvent` 映射，并补测试。
- 不在 hooks 中传完整 secret、完整 `.env`、完整终端历史。

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
