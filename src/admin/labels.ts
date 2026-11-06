/**
 * Pure Chinese labels for the admin console.
 *
 * The console never shows internal words such as `stage=person` or `kind=accept`. Everything it shows about a ticket's
 * state, a decision or a reason passes through here, so the wording stays consistent across overview, list and detail.
 */
import type { AcceptMode, DecisionKind, TicketOutcome } from '../core/model.ts'
import type { Reason } from '../core/reasons.ts'
import type { TicketStage } from '../core/stage.ts'

export type TicketStatusKey = 'running' | 'waiting' | 'needs' | 'queued' | 'completed' | 'stopped' | 'abandoned'

export interface TicketStatusLabel {
  key: TicketStatusKey
  label: string
  /** One sentence: what is happening now and what the person can do. */
  hint: string
}

/** A ticket's stage plus how it ended; either alone cannot tell "已停止" from "已放弃". */
export interface TicketStatusInput {
  stage: TicketStage
  status?: 'open' | 'ended'
  outcome?: TicketOutcome
}

const STATUS: Record<TicketStatusKey, TicketStatusLabel> = {
  running: {
    key: 'running',
    label: '运行中',
    hint: 'AI 正在处理这张票；你可以等它完成，也可以补充说明调整方向。',
  },
  waiting: {
    key: 'waiting',
    label: '等你回复',
    hint: 'AI 提出了问题，回复之后它会继续。',
  },
  needs: {
    key: 'needs',
    label: '需要你处理',
    hint: 'AI 卡住了，需要你看一下最近的报告，决定重试、补充说明还是停止。',
  },
  queued: {
    key: 'queued',
    label: '排队中',
    hint: '这张票已经受理，正在等空闲的并发位置；前面的任务结束后会自动开始。',
  },
  completed: {
    key: 'completed',
    label: '已完成',
    hint: '任务已经完成，可以查看报告和产出。',
  },
  stopped: {
    key: 'stopped',
    label: '已停止',
    hint: '任务被你停止了，不会再继续；需要时还可以重试。',
  },
  abandoned: {
    key: 'abandoned',
    label: '已放弃',
    hint: '任务没有完成就结束了；可以查看报告里的原因，再决定重试或重新发一张票。',
  },
}

const ENDED_OUTCOMES: Record<string, TicketStatusKey> = {
  completed: 'completed',
  merged: 'completed',
  stopped: 'stopped',
  dropped: 'abandoned',
  closed: 'abandoned',
}

/** Turn a ticket's stage (and, when ended, its outcome) into the seven human statuses. */
export function ticketStatusLabel(ticket: TicketStatusInput): TicketStatusLabel {
  const ended = ticket.status === 'ended' || ticket.stage.stage === 'ended'
  if (ended) return STATUS[ENDED_OUTCOMES[String(ticket.outcome ?? '')] ?? 'abandoned']
  switch (ticket.stage.stage) {
    case 'person':
      return ticket.stage.action === 'answer' ? STATUS.waiting : STATUS.needs
    case 'working':
      return ticket.stage.action === 'queued' ? STATUS.queued : STATUS.running
    case 'idle':
      return STATUS.running
    default:
      return STATUS.abandoned
  }
}

const DECISION_KINDS: Record<string, string> = {
  accept: '受理',
  ignore: '忽略',
  reopen: '重新打开',
  stop: '停止',
  unavailable: '判断失败',
}

/** Human label for a decision kind; an unknown kind never leaks its raw value. */
export function decisionKindLabel(kind: DecisionKind | string): string {
  return DECISION_KINDS[String(kind)] ?? '未识别的判断'
}

/**
 * Chinese templates for every code in `core/reasons.ts`. Placeholders keep the same names as the reason values.
 * `{text}` is the person's own message and stays verbatim.
 */
const REASON_LABELS: Record<string, string> = {
  said: '{text}',
  timeout: '判断超时，没有及时得出结论',
  policyChanged: '判断期间受理规则发生了变化',
  noAdmissible: '没有可以受理的消息',
  startedTicket: '这条消息已经开始了任务 {ticket}',
  acceptedBefore: '消息 {trigger} 之前已经受理过',
  routed: '已转交给任务 {ticket}',
  explicitRouted: '允许的发送者明确请求，已经由调度器转交',
  operatorRequest: '你在控制台或命令行直接下达的指令',
  explicitOnly: '当前模式只受理操作员明确下达的指令',
  humanStop: '有人要求停止',
  legacyImport: '从旧版任务记录导入',
  forwarded: '已转交给该会话上已有任务的处理者',
  senderNotMember: '发送者不在该来源的允许名单里',
  retried: '由人手动重试',
  hostRestarted: '服务重启',
  stopUnknown: '要停止的任务不存在或已经结束',
  stopNotExplicit: '停止需要名单里的发送者明确提出',
  directionUnsettled: '还没有确定要实现什么或目标方向，或者仍有产品/设计决定待定',
  noRuleMatched: '没有匹配到任何已启用的受理规则',
  ignoredFromCard: '直接从卡片上忽略，没有走规则判断',
  observed: '观察模式：本来会受理（{text}）',
}

/**
 * Decisions written before reasons had codes stored a plain English sentence, which the repository wraps as
 * `said`. Translating those here keeps old tickets readable without rewriting stored history.
 */
const LEGACY_TEXTS: Record<string, string> = {
  'Direct request from the configured operator': '你在控制台或命令行直接下达的指令',
  'M1 accepts explicit requests only': '当前模式只受理操作员明确下达的指令',
}

export interface ReasonLabel {
  text: string
  /** Raw code and values for an unknown reason; absent for known ones so no internal code reaches the wording. */
  data?: { code: string; values?: Record<string, string> }
}

function fill(template: string, values: Record<string, string> | undefined): string {
  return template.replace(/\{(\w+)\}/g, (_match, name: string) => values?.[name] ?? `{${name}}`)
}

/**
 * Translate one reason code to Chinese. Unknown codes (sources and policy gates may emit their own) fall back to a
 * generic sentence, with the raw code kept in `data` for audit rather than shown to the person.
 */
export function reasonLabel(reason: Reason): ReasonLabel {
  const code = String(reason.code)
  const legacy = code === 'said' ? LEGACY_TEXTS[reason.values?.text ?? ''] : undefined
  if (legacy !== undefined) return { text: legacy }
  const template = REASON_LABELS[code]
  if (template === undefined) {
    return {
      text: '未识别的原因',
      data: { code, ...(reason.values === undefined ? {} : { values: reason.values }) },
    }
  }
  return { text: fill(template, reason.values) }
}

/** Translate a list of reasons, keeping the unknown ones' raw codes in a parallel data list. */
export function reasonLabels(reasons: readonly Reason[]): { texts: string[]; unknown: { code: string; values?: Record<string, string> }[] } {
  const texts: string[] = []
  const unknown: { code: string; values?: Record<string, string> }[] = []
  for (const reason of reasons) {
    const label = reasonLabel(reason)
    texts.push(label.text)
    if (label.data !== undefined) unknown.push(label.data)
  }
  return { texts, unknown }
}

const ACCEPT_MODES: Record<string, string> = {
  auto: '自动接单',
  observe: '只记录，不接单',
  off: '不接新任务',
}

/** Human label for the accept mode. */
export function acceptModeLabel(mode: AcceptMode | string): string {
  return ACCEPT_MODES[String(mode)] ?? '未知的接单方式'
}
