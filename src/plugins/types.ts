/**
 * SuperAgent 2.0 子系统插件协议定义。
 *
 * 目标：让垂直业务与扩展能力（记忆、技能、定时调度，以及未来的量化/运维/扩展模块）
 * 无需侵入式修改 `runtime.ts`、`admin/api.ts`、`director/tools.ts`、`mcp/worker-server.ts`，
 * 统一通过 `PluginRegistry` 注册 HTTP 路由、Director 工具、Worker MCP 工具、上下文注入与生命周期钩子。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { DomainEvent } from '../core/index.ts'
import type { EventLog } from '../ledger/events.ts'
import type { AdminIssue } from '../admin/host.ts'
import type { PluginDescriptor } from '../shared/api-types.ts'

export type { PluginDescriptor }

/** 插件处理 HTTP API 请求时获得的上下文（已通过登录态与 CSRF 校验）。 */
export interface PluginRouteContext {
  req: IncomingMessage
  res: ServerResponse
  url: URL
  method: string
  /** 去掉 `/api` 前缀后的路径，例如 `/memory`、`/schedules/s_123/run`。 */
  route: string
  events: EventLog
  sendJson: (res: ServerResponse, status: number, body: unknown, headers?: Record<string, string>) => void
  parseJsonBody: (req: IncomingMessage) => Promise<unknown>
  invalid: (res: ServerResponse, issues: AdminIssue[]) => void
  decodeSegment: (value: string) => string | undefined
  clampInt: (value: string | null, fallback: number, min: number, max: number) => number
}

/** Director 调用插件工具时透传的会话上下文。 */
export interface DirectorPluginContext {
  sessionId: string
  channel: 'wechat' | 'web' | 'feishu' | 'qq'
  userId: string
  focusTicketId?: string | null
}

/** 构建 Director 系统提示词时提供给插件的动态上下文。 */
export interface DirectorPromptInjectionContext {
  channel: 'wechat' | 'web' | 'feishu' | 'qq'
  userId: string
  userMessage?: string
  focusTicketId?: string | null
}

/** Director 高危动作定义（自动进入代码级二次确认审批流）。 */
export interface DirectorHighRiskPluginAction {
  summary: (args: Record<string, unknown>) => string
  execute: (args: Record<string, unknown>, ctx: DirectorPluginContext) => Promise<unknown> | unknown
}

/** Worker 调用插件 MCP 工具时由宿主令牌绑定的身份上下文。 */
export interface WorkerPluginContext {
  ticketId: string
  assignmentId: string
  role: string
  projectId?: string
}

/** 工单启动拼装上下文（如 AGENTS.md / 任务指令）时提供给插件的信息。 */
export interface WorkerPromptInjectionContext {
  ticketId: string
  title?: string
  promptText?: string
  projectId?: string
  projectName?: string
}

/** 标准子系统插件接口。 */
export interface SubsystemPlugin {
  /** 唯一标识，如 `memory`、`skills`、`scheduler`、`novel`。 */
  readonly id: string
  /** 展示名称（中文）。 */
  readonly name: string
  /** 简短功能描述。 */
  readonly description: string
  /** 版本号。 */
  readonly version: string
  /** 声明式前缀提示（仅用于展示/自检）。 */
  readonly routesPrefix?: string
  /** 动态启用判断，省略则默认启用。 */
  enabled?: () => boolean

  /** 扩展 `/api/*` 路由；处理了请求返回 `true`，未命中返回 `false`。 */
  handleRoute?: (ctx: PluginRouteContext) => Promise<boolean> | boolean

  /** 扩展 Director `platform_query` 只读动作。 */
  directorQueries?: Record<string, (args: Record<string, unknown>, ctx: DirectorPluginContext) => Promise<unknown> | unknown>

  /** 扩展 Director `subsystem_action` 操作动作。 */
  directorActions?: Record<string, (args: Record<string, unknown>, ctx: DirectorPluginContext) => Promise<unknown> | unknown>

  /** 扩展 Director `high_risk_action` 高危确认动作。 */
  directorHighRiskActions?: Record<string, DirectorHighRiskPluginAction>

  /** 向 Director 系统提示词追加一段插件专属上下文（如长期记忆/技能清单/工具速查）。 */
  directorPromptSection?: (ctx: DirectorPromptInjectionContext) => string | undefined

  /** 向 Worker MCP Server 注册受工单令牌保护的工具。 */
  registerWorkerMcpTools?: (server: McpServer, ctx: WorkerPluginContext) => void

  /** 向 Worker 启动上下文（AGENTS.md）追加插件专属片段（如项目避坑经验与相关技能）。 */
  workerPromptSection?: (ctx: WorkerPromptInjectionContext) => string | undefined

  /** 监听核心引擎领域事件（如 `ticket.ended` 自动复盘沉淀）。 */
  onDomainEvent?: (event: DomainEvent) => void

  /** 守护进程启动时执行。 */
  start?: () => Promise<void> | void

  /** 守护进程关闭时执行（按注册逆序停机）。 */
  stop?: () => Promise<void> | void
}
