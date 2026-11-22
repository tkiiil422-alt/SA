/**
 * 前后端共享的 API 契约类型定义（纯类型，零运行时开销）。
 *
 * 供后端 `src/admin/*`、`src/memory/*`、`src/skills/*`、`src/scheduler/*`、`src/plugins/*`
 * 与前端 `web/src/*` 共同引用，逐步消除跨端 `any` 漂移。
 */

/** 已加载子系统插件的运行态摘要。 */
export interface PluginDescriptor {
  id: string
  name: string
  description: string
  version: string
  enabled: boolean
  routesPrefix?: string
  directorActions: string[]
  workerTools: string[]
}

/** 三层长期记忆作用域。 */
export type MemoryScope = 'user' | 'project' | 'ticket'

/** 记忆条目分类。 */
export type MemoryKind = 'preference' | 'fact' | 'pitfall' | 'decision' | 'retro'

/** 单条长期记忆记录。 */
export interface MemoryRecord {
  id: string
  scope: MemoryScope
  kind: MemoryKind
  projectId: string | null
  ticketId: string | null
  title: string
  content: string
  tags: string[]
  confidence: number
  pinned: boolean
  useCount: number
  lastUsedAt: string | null
  source: string
  createdAt: string
  updatedAt: string
}

/** 记忆列表与召回响应。 */
export interface MemoryListResponse {
  items: MemoryRecord[]
  total: number
}

/** 技能适用范围。 */
export type SkillScope = 'director' | 'worker' | 'both'

/** 单条可复用技能/SOP 记录。 */
export interface SkillRecord {
  id: string
  slug: string
  name: string
  description: string
  scope: SkillScope
  triggers: string[]
  tags: string[]
  content: string
  enabled: boolean
  useCount: number
  lastUsedAt: string | null
  createdAt: string
  updatedAt: string
}

export interface SkillListResponse {
  items: SkillRecord[]
  total: number
}

/** 主动调度触发方式。 */
export type ScheduleTriggerKind = 'cron' | 'interval' | 'once'

/** 主动调度执行动作类型。 */
export type ScheduleActionKind = 'dispatch_ticket' | 'director_prompt' | 'http_watch'

/** 定时任务或条件巡检配置。 */
export interface ScheduleRecord {
  id: string
  name: string
  description: string
  enabled: boolean
  triggerKind: ScheduleTriggerKind
  /** 5 段标准 Cron（分 时 日 月 周），triggerKind='cron' 时有效。 */
  cronExpr: string | null
  /** 间隔秒数，triggerKind='interval' 时有效（最小 30 秒）。 */
  intervalSec: number | null
  /** 一次性触发 ISO 时间，triggerKind='once' 时有效。 */
  runAt: string | null
  /** 调度动作类型。 */
  actionKind: ScheduleActionKind
  /** 动作参数（工单 prompt / director 指令 / http_watch URL 与检测规则）。 */
  actionConfig: Record<string, unknown>
  /** 系统处于全局暂停（paused）时是否跳过。 */
  respectPause: boolean
  nextRunAt: string | null
  lastRunAt: string | null
  lastStatus: 'never' | 'running' | 'ok' | 'skipped' | 'changed' | 'error'
  lastSummary: string
  runCount: number
  failCount: number
  createdAt: string
  updatedAt: string
}

/** 单次调度执行历史记录。 */
export interface ScheduleRunRecord {
  id: string
  scheduleId: string
  startedAt: string
  finishedAt: string | null
  status: 'running' | 'ok' | 'skipped' | 'changed' | 'error'
  summary: string
  ticketId: string | null
  error: string | null
  durationMs: number | null
}

export interface ScheduleListResponse {
  items: ScheduleRecord[]
  total: number
  now: string
}

export interface ScheduleRunsResponse {
  items: ScheduleRunRecord[]
}

/** 控制台顶部实时看板（SSE `/api/live/stream`）。 */
export interface LiveRunningStep {
  id: string
  summary: string
  kind: string
  at: string
  tool?: string
  status?: string
  since?: string
  model?: string
  agents?: { role: string; name?: string; model?: string; state: string }[]
}

export interface LiveBoardTicket {
  id: string
  title: string
  status: string
  outcome?: string
  needsPerson?: boolean
  question?: string
  stageLabel?: string
  updatedAt: string
  costUsd: number
  goal?: { status: string; rounds: number; roundCap: number }
  [key: string]: any
}

export interface LiveBoardSnapshot {
  now: string
  paused: boolean
  slots: { used: number; max: number; reservedForPerson?: number }
  tickets: { open: number; running: number; needsPerson: number; endedToday: number }
  usage: { todayUsd: number; todayCalls?: number; dailyBudgetUsd?: number }
  upstream?: { ok: boolean; model?: string; provider?: string }
  runningSteps: LiveRunningStep[]
  open: LiveBoardTicket[]
  ended: LiveBoardTicket[]
  alerts: { level: string; text: string; link?: string }[]
}
