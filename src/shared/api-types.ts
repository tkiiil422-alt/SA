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
  /** 关联工单真实终态（completed / merged / closed / dropped / stopped / failed）。 */
  ticketOutcome?: string | null
  /** 关联工单验收状态（met / unmet / not_checked）。 */
  acceptanceStatus?: string | null
  /** 用户针对该次任务或记忆的反馈说明。 */
  userFeedback?: string | null
  /** 本条记忆纠正/替代的旧记忆 ID。 */
  supersedesId?: string | null
  /** 若已被更新的记忆纠正替代，记录替代者 ID。 */
  supersededBy?: string | null
  /** 推断型经验关联的客观证据摘要。 */
  evidence?: string[]
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
  /** 三态分列：派发状态。 */
  dispatchStatus: 'pending' | 'dispatched' | 'skipped' | 'failed'
  /** 三态分列：执行状态。 */
  executionStatus: 'pending' | 'running' | 'succeeded' | 'failed' | 'skipped'
  /** 三态分列：验收状态。 */
  acceptanceStatus: 'not_required' | 'pending' | 'passed' | 'failed'
  /** 本次运行实际采用的任务约定版本号（保留历史口径，不受后续修改影响）。 */
  contractVersion: number | null
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

/** 扩展后的项目挂载模式：`copy` 独立副本、`direct` 原件直改、`worktree` Git 并发隔离分支。 */
export type ProjectWorkspaceMode = 'copy' | 'direct' | 'worktree'

/** DAG 任务计划（Mission）整体状态。 */
export type MissionStatus = 'draft' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled'

/** 单个任务节点类型。 */
export type MissionNodeKind = 'ticket' | 'council' | 'director' | 'approval'

/** 单个任务节点状态。 */
export type MissionNodeStatus = 'pending' | 'running' | 'waiting_approval' | 'completed' | 'failed' | 'skipped' | 'cancelled'

export interface MissionNodeRecord {
  id: string
  missionId: string
  key: string
  title: string
  kind: MissionNodeKind
  prompt: string
  dependsOn: string[]
  config: Record<string, unknown>
  status: MissionNodeStatus
  ticketId: string | null
  councilId: string | null
  outputSummary: string
  error: string | null
  retries: number
  startedAt: string | null
  finishedAt: string | null
  orderIndex: number
}

export interface MissionRecord {
  id: string
  sessionId: string | null
  title: string
  goal: string
  status: MissionStatus
  autoStart: boolean
  summary: string
  createdAt: string
  updatedAt: string
  nodes: MissionNodeRecord[]
}

export interface MissionListResponse {
  items: MissionRecord[]
  total: number
}

/** 工单代码改动 Diff 审查视图。 */
export interface TicketDiffFile {
  path: string
  status: string
  additions: number
  deletions: number
}

export interface TicketDiffResponse {
  available: boolean
  reason?: string
  mode?: ProjectWorkspaceMode
  branch?: string
  baseRef?: string
  projectId?: string
  projectName?: string
  canMerge?: boolean
  files: TicketDiffFile[]
  diff: string
  truncated: boolean
}

/** 总控助手流式思考与工具调用进度事件（SSE `/api/director/chat/stream`）。 */
export type DirectorProgressEvent =
  | { type: 'start'; sessionId: string; model?: string }
  | { type: 'thinking'; step: number; message: string }
  | { type: 'tool_start'; step: number; name: string; action?: string; summary: string }
  | { type: 'tool_done'; step: number; name: string; action?: string; ok: boolean; ms: number; summary: string; pendingActionId?: string }
  | { type: 'done'; result: Record<string, unknown> }
  | { type: 'error'; message: string }

/** 统一任务约定（Task Contract）：跨对话、Web、定时调度与 DAG 共用。 */
export type ContractTargetKind = 'ticket' | 'schedule' | 'mission'
export type AmendmentScope = 'once' | 'project' | 'preference'

export interface ContractCriterion {
  id: string
  text: string
  required: boolean
}

export interface TaskContractRecord {
  id: string
  targetKind: ContractTargetKind
  targetId: string
  version: number
  projectId: string | null
  goal: string
  deliverables: string[]
  criteria: ContractCriterion[]
  assumptions: string[]
  budgetUsd: number | null
  allowedScope: string
  amendmentScope: AmendmentScope
  amendmentReason: string
  createdAt: string
  updatedAt: string
}

export interface TaskContractVersionRecord {
  contractId: string
  version: number
  goal: string
  deliverables: string[]
  criteria: ContractCriterion[]
  assumptions: string[]
  budgetUsd: number | null
  allowedScope: string
  amendmentScope: AmendmentScope
  reason: string
  createdAt: string
}

/** 逐项验收证据记录：标明执行 ID、产物版本与客观验证结果。 */
export interface VerificationEvidence {
  id: string
  kind: 'command' | 'file' | 'git' | 'browser' | 'data' | 'judge'
  criterionId?: string
  runId: string
  artifactVersion: string
  passed: boolean
  summary: string
  detail?: string
  at: string
}

/** 面向用户的交付回执：一眼看到交付物、逐条通过情况、证据与是否需要人工决策。 */
export interface DeliveryReceipt {
  ticketId: string
  contractVersion: number | null
  status: 'verified' | 'partial' | 'failed' | 'pending'
  deliverables: { path: string; size?: number; kind?: string }[]
  criteria: {
    id: string
    text: string
    required: boolean
    status: 'passed' | 'failed' | 'pending'
    evidences: VerificationEvidence[]
  }[]
  evidences: VerificationEvidence[]
  pendingItems: string[]
  needsDecision: boolean
  decisionPrompt?: string
  generatedAt: string
}


