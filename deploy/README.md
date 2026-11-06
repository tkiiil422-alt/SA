# Debian 主机部署（M1）

目标主机：`deploy@your-host`（示例为 Debian 13 trixie，4 核 / 16 GB 内存）。
本目录只负责"把 worker 关进容器"和"把守护进程交给 systemd"，业务代码仍在 `src/`。

## 0. 主机前置（一次性）

```bash
sudo apt-get update
sudo apt-get install -y podman uidmap slirp4netns fuse-overlayfs passt containernetworking-plugins
sudo loginctl enable-linger deploy     # 让 systemd --user 和 rootless podman 在未登录时也能跑
```

Node 22 用官方 tar 包装到 `/usr/local/lib/nodejs/`，不要用 Debian 自带的 20（`node:sqlite` 需要 22+）：

```bash
VER=node-v22.23.4-linux-x64
wget -q https://nodejs.org/dist/latest-v22.x/$VER.tar.xz
wget -qO- https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt | grep "$VER.tar.xz" | sha256sum -c -
sudo mkdir -p /usr/local/lib/nodejs && sudo tar -xf $VER.tar.xz -C /usr/local/lib/nodejs
for b in node npm npx; do sudo ln -sf /usr/local/lib/nodejs/$VER/bin/$b /usr/local/bin/$b; done
sudo npm install -g pnpm@10 && sudo ln -sf /usr/local/lib/nodejs/$VER/bin/pnpm /usr/local/bin/pnpm
```

## 1. 构建镜像

```bash
cd ~/superagent
podman build -f deploy/Containerfile.pi -t localhost/superagent-pi:1.5.0 deploy/
podman run --rm localhost/superagent-pi:1.5.0 pi --version   # 应输出 1.5.0
```

镜像里不含任何密钥。Pi 的版本是钉死的：升级 Pi 等于改 RPC 协议，必须先跑 `pnpm check`。

## 2. 上游与 key

M1 实际接的上游是 **OpenCode Zen Go**（`https://opencode.ai/inference/go/openai/v1`），不是 DeepSeek 官方端点。
它和 DeepSeek 有三处差异，都已经在代码里适配：

| 差异 | 适配位置 |
|---|---|
| 模型 id 是 `deepseek-v4.1-flash`（`deepseek-flash` 会报 Model is unavailable） | 每票 `models.json` 里显式声明该 id（`src/runtime.ts`），启动参数用 `--model deepseek-v4.1-flash` |
| 必须带 `x-opencode-session` 头，否则 400 `MissingSessionID` | 网关 `upstreamHeaders`，值取票 id（同一票固定，保住后端亲和与缓存） |
| 缓存命中在 `prompt_tokens_details.cached_tokens`，不是 `prompt_cache_hit_tokens` | `src/gateway/usage.ts` 两个字段都认 |
| 上游带路径前缀 `/inference/go/openai/v1` | 网关 `targetUrl` 把来路路径**追加**到 base 路径后（曾经是替换，导致 404） |

key 只放在仓库外的环境文件里，权限 0600：

```bash
install -d -m 700 ~/.config/superagent
cat > ~/.config/superagent/env <<'EOF'
DEEPSEEK_API_KEY=oc_sk-...
SA_DEEPSEEK_UPSTREAM=https://opencode.ai/inference/go/openai/v1
SA_UPSTREAM_SESSION_HEADER=x-opencode-session
EOF
chmod 600 ~/.config/superagent/env
```

网关按请求体里的 `model` 查价（`deepseek-v4.1-flash` / `deepseek-flash` / `deepseek-v4-pro` 同一张表），
并把命中/未命中/输出 token 记进日志；余额不足返回 402，worker 拿不到上游 key。

**已实测**（2026-11-05，systemd 托管）：同一票第二轮 `hit=2432 miss=189`，约 93% 前缀命中；
首轮 `hit=0 miss=2521` 属正常冷启动。

## 3. 启动器

`deploy/pi-container.sh` 被 `examples/config.debian.json` 的 `launcher.command` 指向，运行时按票调用：

| 变量 | 来源 | 用途 |
|---|---|---|
| `PI_CODING_AGENT_DIR` | runtime | 每票的 Pi 配置目录，内含 `models.json` / `mcp.json` |
| `SA_TICKET_TOKEN` | runtime | 本票 bearer token，网关和 MCP 都只认它 |
| `SA_MCP_URL` / `SA_GATEWAY_URL` | runtime | worker 要连的两个本机端点 |
| `SA_WORKSPACE_ROOT` | config | 每票工作目录的根，容器里挂成 `/workspace` |
| `SA_PI_CPUS` / `SA_PI_MEMORY` | config | 单容器上限，按机器规格给（示例 2 核 / 6 GB） |

容器：`--rm`、`--userns=keep-id`、`--read-only`（只有 `/tmp`、`/home/pi` 和两个挂载点可写）、
`--pids-limit=512`、`--security-opt=no-new-privileges`。

网络：容器用 rootless Podman 的 `pasta` 网络，有自己的网络命名空间，能上公网。脚本从 `SA_GATEWAY_URL` / `SA_MCP_URL`
取出两个端口，用 `--network=pasta:--no-map-gw,-T,<网关端口>,-T,<MCP 端口>` 只把这两个端口从容器回环转发到主机回环，
所以 `models.json` / `mcp.json` 里的 `127.0.0.1:<port>` 照常可用，而后台（8787）、控制端口和主机上其它本地服务
（例如 7890 代理）在容器里一律连不上。`--no-map-gw` 防止经网关地址摸到主机。需要临时换回旧行为可设
`SA_PI_NETWORK=host`（不建议）。2026-11-05 实测：容器内访问 `127.0.0.1:8787` 为 ECONNREFUSED，`https://opencode.ai/` 为 200。

## 3.1 多模型

- 在后台「设置 → 模型」里配置服务商、模型和默认分工；发任务时可以指定模型，也可以让分析模型自动挑。
- 工人不直接访问服务商，而是经网关 `/p/<服务商 id>/...` 转发，每票只持有本票令牌。
- 真实密钥只保存在 `state/options.json`（权限 0600），不会出现在任何页面、事件、日志或错误信息里。

## 4. systemd（用户级）

```bash
mkdir -p ~/.config/systemd/user
cp ~/superagent/deploy/superagent.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now superagent.service
systemctl --user status superagent.service
journalctl --user -u superagent.service -f
```

停止要验优雅退出：`systemctl --user stop superagent.service` 后不应残留 `sa-*` 容器：

```bash
podman ps --format '{{.Names}}' | grep '^sa-' || echo "no leftover containers"
```

## 5. 冒烟

```bash
cd ~/superagent
node --experimental-transform-types src/cli/sa.ts ask "用一句话说明当前目录有哪些文件" --source cli
node --experimental-transform-types src/cli/sa.ts tickets
```

预期：票被 accept，容器 `sa-<ticketId>` 起来，Pi 通过 MCP 调 `sa_report`，结果落到 outbox 并由 CLI 打出来。

## 6. 更新代码

只同步代码、测试、部署脚本和依赖清单，**不要**同步 `state/`（数据库、口令、飞书配置、`cli-token`）和
`node_modules/`：

```bash
# 在构建机上执行
rsync -av src/ tests/ deploy/ package.json pnpm-lock.yaml deploy@your-host:~/superagent/
```

然后在主机上：

```bash
cd ~/superagent
bash deploy/deploy.sh
```

`deploy.sh` 会修脚本权限、按 lockfile 安装依赖、类型检查、重启服务并做健康检查。

## 7. 备份与恢复

守护进程每次启动会备份一次；之后每小时检查，最新备份超过 24 小时就再备份。默认写到
`~/superagent-backups/state-YYYYMMDD-HHMMSS.tgz`（0600，保留最新 7 份），可用环境变量 `SA_BACKUP_DIR` 改目录。
后台「系统」页也能列出备份并「立即备份」。备份里是 SQLite 一致快照（`VACUUM INTO`）加
`options.json` / `settings.json` / `admin.json` 等小配置文件，**不含** `cli-token` 和 `pi-config/`。

恢复必须停服务，再解包覆盖 `state/`：

```bash
systemctl --user stop superagent.service
mkdir -p /tmp/sa-restore
tar -xzf ~/superagent-backups/state-<时间>.tgz -C /tmp/sa-restore
cp -a /tmp/sa-restore/. ~/superagent/state/
systemctl --user start superagent.service
```

按实际 `stateDir` 调整上面的 `~/superagent/state/`。恢复后 `cli-token` 会重新生成，后台口令以备份里的
`admin.json` 为准。
