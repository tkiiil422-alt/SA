# SuperAgent

自托管（Self-Hosted）的多模型 AI Agent 运行时与全平台控制台：将任务执行放进受限 Podman 容器沙箱，由统一网关、账本与 MCP 协议管控模型调用与工具权限，并提供面向日常运维、软件研发、安全审计与内容创作的全链路控制平面。

> 领域内核（`src/core/`）、策略/准入/限额、文本工具及核心内核测试源自 MIT 开源原型 [dsh-superagent-prototype](https://github.com/deepseek-ai/dsh-superagent-prototype)（commit `8c32a9d`）。完整署名与许可证文本见 [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)。

---

## 核心能力

### 1. 总控 AI 助手（Director）
- **多端统一入口**：接入**飞书**（Webhook / 长连接 WebSocket）、**微信**（个人微信 iLink 扫码 / 企业微信 / 公众号 / Webhook 桥接）与**控制台 Web 对话**。
- **全平台控制台与宿主机掌管**：支持查询全部运行指标、管理任务工单、调用各子系统，以及修改**全部 17 个平台配置分区**（模型服务商/模型清单/API Key/路由、总控模型与重试次数、并发与资源、预算、受理策略、通道凭据、联网搜索、协作与会商角色、小说/目标/预览/项目限制、SSH 全局策略等）。
- **宿主机运维（Host Ops）**：支持主机资源巡检、systemd 服务日志与状态查看、Podman 容器/镜像维护及受控主机命令执行（自动屏蔽敏感凭据路径）。
- **自动续接（Follow-ups）**：派单或发起会商时支持 `onComplete` 触发器，任务结束后自动唤醒总控推进部署、验收或下一步动作。
- **L3 安全闸门与递归脱敏**：所有写配置、宿主机命令、服务启停、镜像删除、密钥与 SSH 变更均经代码级二次确认（短码 `/确认` 或 `/取消`）；确认摘要与审计日志自动递归脱敏密钥。

### 2. 容器沙箱与执行器（Executor / Pi / DevEnv）
- **Podman 容器隔离**：每个工单运行在独立的 `--read-only` rootless Podman 容器中，基于 `pasta` 网络仅转发网关与 MCP 端口，阻断容器对宿主机其他本地服务的访问。
- **Pi 版本与开发环境管理**：支持在线检查/构建/切换 Pi 镜像（`Containerfile.pi`），以及一键构建或极速复用（`repack`）带浏览器、数据库、常用语言与调试工具的开发环境镜像（`Containerfile.dev`），自动配置镜像加速与重试。
- **实时预览代理**：为工单容器动态分配宿主机端口并生成带令牌的预览路径。

### 3. 多模型网关、协作与会商
- **统一模型网关与自动发现**：兼容 `openai-completions` 与 `anthropic-messages` 协议，支持远端模型拉取（`discover`）、连通性测通、缓存命中统计与预算熔断。
- **智能路由与多角色协作**：支持任务前分析选模（`assessor`）、工单内多角色子代理协作（`collab`）及任务前多角色讨论会商（`council`）。

### 4. 项目库、工作树与目标验收
- **项目库（Projects）**：支持目录导入与分片压缩包上传，提供 `copy`（沙箱副本）与 `direct`（直改原件 + 自动快照可回滚）双模式、`worktree` 隔离以及 `AGENTS.md` 规范注入。
- **目标验收（Goal）、任务编排（Missions）与评测（Eval）**：支持命令 + AI 联合验收循环，受最大轮次、预算与时长护栏约束。

### 5. 长期记忆、技能库与主动调度
- **三层记忆（Memory）**：沉淀用户偏好、项目知识与任务复盘。
- **技能库与插件（Skills & Plugins）**：支持复用 SOP 技能与插件注册表。
- **定时与巡检（Scheduler）**：支持 Cron 定时派单、总控主动巡检与零 Token HTTP 监控。

### 6. 安全与防御工作台、密钥库与多渠道接入
- **防御工作台（`#/defense`）与渗透工作台（`#/pentest`）**：提供纯防御视角的应用安全代码审查/基线核查/加固闭环（含 6 套防御 Playbook），以及内部红队扫描工作台，支持一键推送邮件报告。
- **密钥保险库（Vault）与 SSH 管理**：凭据加密存储于宿主端，工单仅在明确授权后按需注入，不接触宿主机明文密钥。
- **多通道与扩展引擎**：集成飞书、微信、IMAP/SMTP 邮件、GitHub PR 联动，以及长篇小说写作引擎与番茄发布（`fanqie`）。

---

## 目录结构

```text
superagent/
├── src/
│   ├── admin/          # 控制台 HTTP API、鉴权、运行时选项与静态服务
│   ├── assessor/       # 任务分析与模型调用封装
│   ├── cli/            # 命令行工具 `sa`
│   ├── control/        # 守护进程本地控制面
│   ├── core/           # 工单状态机与领域内核
│   ├── council/        # 多角色会商服务
│   ├── director/       # 总控 AI 助手（对话、工具路由、配置补丁、主机运维、自动续接）
│   ├── effects/        # 副作用队列与持久化调度
│   ├── eval/           # 评测运行器
│   ├── executor/       # Pi RPC 执行器、协作扩展、Pi 版本与开发环境镜像管理
│   ├── fanqie/         # 番茄小说同步与发布集成
│   ├── gateway/        # 多模型代理网关、路径重写与用量定价
│   ├── goal/           # 目标循环验收服务
│   ├── infra/          # 基础设施工具、二维码与命令垫片
│   ├── ledger/         # 用量账本、事件日志与模型选择记录
│   ├── mcp/            # Worker MCP 服务端
│   ├── memory/         # 三层记忆存储与检索
│   ├── missions/       # 多阶段任务编排
│   ├── novel/          # 长篇小说流水线与章节质量校验
│   ├── outbox/         # 外发消息队列
│   ├── pentest/        # 防御工作台与安全评估服务
│   ├── plugins/        # 插件注册表与加载器
│   ├── projects/       # 项目库管理、分片上传、快照与 worktree
│   ├── runtime/        # 运行时装配与生命周期管理
│   ├── scheduler/      # Cron / Watch 定时调度器
│   ├── shared/         # 前后端共享 API 类型定义
│   ├── skills/         # 技能 SOP 库
│   ├── sources/        # 飞书 / 微信 / 邮件 / GitHub 消息源接入
│   ├── ssh/            # SSH 连接配置与主机指纹扫描
│   ├── store/          # SQLite 持久化层
│   ├── web/            # 联网搜索与网页抓取服务
│   ├── daemon.ts       # 守护进程入口
│   └── runtime.ts      # 系统主装配入口
├── web/                # React + Vite 控制台前端（构建产物输出至 src/admin/web-next）
├── deploy/             # Podman Containerfile、容器启动脚本、systemd 单元与部署指南
├── examples/           # 示例配置文件
└── tests/              # Vitest 单元测试与端到端测试套件
```

---

## 快速开始

### 环境要求
- **Node.js** >= 22.19（需内置 `node:sqlite` 与 `--experimental-transform-types`）
- **pnpm** 10+
- **Podman**（Linux 宿主机运行隔离执行容器所需；本地单测与类型检查可在 Windows/macOS/Linux 直接运行）

### 安装与校验

```bash
# 安装后端依赖
pnpm install

# 安装并构建前端控制台
pnpm --dir web install
pnpm --dir web build

# 类型检查与全量测试
pnpm typecheck
pnpm test
pnpm check
```

### 运行守护进程与 CLI

```bash
# 启动守护进程（需先准备配置文件，参见 examples/ 与 deploy/README.md）
pnpm daemon

# 使用 CLI 交互
pnpm sa tickets
pnpm sa ask "检查当前项目测试状态" --source cli
```

---

## 部署与运维

Debian / Linux 宿主机的 rootless Podman、`pasta` 网络隔离、Pi/DevEnv 容器构建及 `systemd --user` 托管说明，请参阅：

- [deploy/README.md](./deploy/README.md)
- 部署脚本：[deploy/deploy.sh](./deploy/deploy.sh)、[deploy/pi-container.sh](./deploy/pi-container.sh)
- 服务模板：[deploy/superagent.service](./deploy/superagent.service)

---

## 致谢与协议

- 核心内核与部分基础模块基于 MIT 协议移植自 [dsh-superagent-prototype](https://github.com/deepseek-ai/dsh-superagent-prototype)。
- 其余第三方开源致谢与完整许可证文本见 [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)。
