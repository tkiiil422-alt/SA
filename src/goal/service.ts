/**
 * Ticket goals: a ticket may carry a goal that must be reached before it ends.
 *
 * The worker learns the goal from its system prompt (`systemPrompt`). When it reports `ready`, or gives up with
 * `failed`/`dropped`, the worker MCP endpoint hands the report to `gate` before the Engine sees it: the host runs the
 * goal's acceptance commands in the worker's own container and, by default, asks a judge model whether the goal is met.
 * Met: the report goes through (a give-up becomes `ready`) and the ticket ends. Not met: a `progress` report is recorded
 * in its place and the worker is told what is missing, so it keeps working. A turn that ends without a delivery is pushed
 * on (`afterTurn`). Rounds, spend and time are capped; at a cap the ticket asks a person (`blocked` with a question) and
 * a person's reply grants another batch (`personReplied`). `src/core/` is unchanged: all of this sits in front of it.
 *
 * Goals are stored by the ticket's origin trigger id, so a goal given with a new request is in place before the first
 * launch, which can run before the ticket id is known.
 */
import { randomBytes } from 'node:crypto'
import type { DatabaseSync, StatementSync } from 'node:sqlite'
import type { WorkerReport } from '../core/index.ts'
import type { ContractCriterion, DeliveryReceipt, VerificationEvidence } from '../shared/api-types.ts'
import { classifyGoalFailure, type FailureDiagnosis } from './classifier.ts'

export type GoalMode = 'commands+ai' | 'commands' | 'ai'
export type GoalStatus = 'active' | 'met' | 'paused' | 'cancelled'

export interface GoalSpec {
  text: string
  /** Shell commands run in `/workspace`; every one must exit 0. Empty in `ai` mode. */
  commands: string[]
  mode: GoalMode
  maxRounds: number
  maxUsd: number
  maxHours: number
  /** 逐项验收条件清单（每条必选条件需有具体验证证据）。 */
  criteria?: ContractCriterion[]
  /** 是否要求必须具备客观验证证据才允许通过（默认 true）。 */
  requireEvidence?: boolean
}

/** A goal as a person writes it; what is left out comes from the settings. */
export interface GoalInput {
  text: string
  commands?: string[]
  mode?: GoalMode
  maxRounds?: number
  maxUsd?: number
  maxHours?: number
  criteria?: (string | ContractCriterion)[]
  requireEvidence?: boolean
}

export interface GoalSettings {
  maxRounds: number
  maxUsd: number
  maxHours: number
  commandTimeoutSec: number
  /** Null means the ticket's own model. */
  judge: { provider: string; model: string } | null
}

export interface CommandResult { command: string; code: number; ms: number; tail: string }
export interface Verdict { met: boolean; evidence: string[]; missing: string[]; summary: string }
/** A file the goal names, read by the host straight from the workspace for the judge; `text` may be only its head. */
export interface GoalFile { path: string; size: number; text: string; truncated: boolean; binary?: boolean }

/** One goal check (the worker delivered) or push (a turn ended without a delivery). */
export interface GoalCheck {
  at: string
  round: number
  kind: 'check' | 'nudge'
  met: boolean
  summary: string
  commands: CommandResult[]
  verdict?: Verdict
  error?: string
  /** Why the goal stopped to ask a person, when this check or push hit a cap. */
  paused?: string
  /** The workspace files whose contents the judge saw. */
  files?: string[]
  /** 本次检查归集的结构化证据（标明执行 ID 与产物版本）。 */
  evidences?: VerificationEvidence[]
  /** 失败根因分类（信息不足 / 环境异常 / 推理受阻）。 */
  diagnosis?: FailureDiagnosis
}

export interface GoalView extends GoalSpec {
  status: GoalStatus
  rounds: number
  roundCap: number
  usdUsed: number
  usdCap: number
  startedAt: string
  deadline: string
  checking: boolean
  last?: GoalCheck
  checks: GoalCheck[]
  evidences?: VerificationEvidence[]
  escalatedTo?: string
}

/** What the goal service needs to know about a ticket. */
export interface GoalTicket {
  triggerId: string
  ended: boolean
  waitsForPerson: boolean
  /** The ticket's open question for a person, if any. */
  question?: string
  undelivered: number
  /** The current assignment's latest report, `progress` included. */
  report?: { state: string; at: string }
}

export type CommandRunner = (ticketId: string, command: string, timeoutSec: number) => Promise<CommandResult>
export interface JudgeInput { ticketId: string; goal: GoalSpec; summary: string; commands: CommandResult[]; context: string; files?: GoalFile[] }
export type JudgeResult = { ok: true; verdict: Verdict } | { ok: false; error: string }
export type Judge = (input: JudgeInput) => Promise<JudgeResult>
export type GateDecision =
  | { action: 'pass' }
  | { action: 'replace'; report: WorkerReport; reply: string }
  | { action: 'reply'; reply: string }

export interface GoalDeps {
  db: DatabaseSync
  ticket(id: string): GoalTicket | undefined
  /** The ticket's spend so far in USD. */
  spend(ticketId: string): number
  settings(): GoalSettings
  run: CommandRunner
  /** A short description of the workspace (files, git status) for the judge; optional. */
  context?: (ticketId: string) => Promise<string>
  /** Reads the workspace files the goal names (see `goalFileNames`), within size limits, for the judge; optional. */
  files?: (ticketId: string, names: string[]) => Promise<GoalFile[]>
  judge: Judge
  /** Records a report on the ticket; used when a push hits a cap. */
  report(ticketId: string, report: WorkerReport): void
  step?(ticketId: string, summary: string, detail: string, status: 'done' | 'error'): void
  event?(ticketId: string, level: 'info' | 'warn', text: string): void
  /** Tells a running worker something (a goal set or cancelled while it works). */
  notify?(ticketId: string, text: string): void
  /**
   * 模型阶梯升级钩子：仅在失败分类器判定为 `reasoning_blocked` 且预算内有余量时触发，
   * 携带已有成果、失败证据、历史尝试记录与剩余预算交接给更强模型。
   */
  escalateModel?(ticketId: string, ctx: {
    round: number
    reason: string
    diagnosis: FailureDiagnosis
    remainingUsd: number
    previousAttempts: string[]
    evidences: VerificationEvidence[]
    latestSummary: string
  }): Promise<{ from: string; to: string } | undefined> | { from: string; to: string } | undefined
  /** 返回当前工单工作区的产物版本号（例如 git commit SHA 或目录指纹），用于绑定验证证据。 */
  artifactVersion?(ticketId: string): Promise<string> | string
  now?: () => Date
}

export class GoalError extends Error {
  constructor(readonly field: string, message: string) {
    super(message)
    this.name = 'GoalError'
  }
}

const CHECKS_KEPT = 20
/** No acceptance command of one check starts after this long, so a check ends well inside the MCP timeout. */
const COMMANDS_BUDGET_MS = 15 * 60_000
const PASS: GateDecision = { action: 'pass' }

const clip = (text: string, limit: number): string => text.length <= limit ? text : `${text.slice(0, limit)}…`
const describe = (error: unknown): string => error instanceof Error ? error.message : String(error)
const money = (usd: number): string => `$${usd.toFixed(usd < 1 ? 3 : 2)}`

/** A goal as a person wrote it, completed from the settings. */
export function resolveGoal(input: GoalInput, defaults: Pick<GoalSettings, 'maxRounds' | 'maxUsd' | 'maxHours'>): GoalSpec {
  const text = input.text.trim()
  if (!text) throw new GoalError('text', '请写清目标')
  const commands = (input.commands ?? []).map(command => command.trim()).filter(Boolean)
  const mode: GoalMode = input.mode ?? (commands.length > 0 ? 'commands+ai' : 'ai')
  if (mode !== 'ai' && commands.length === 0) throw new GoalError('commands', '这种判定方式至少要写一条验收命令')
  const criteria: ContractCriterion[] = (input.criteria ?? [])
    .map((item, idx) => typeof item === 'string'
      ? { id: `c${idx + 1}`, text: item.trim(), required: true }
      : { id: item.id.trim() || `c${idx + 1}`, text: item.text.trim(), required: item.required !== false })
    .filter(c => c.text.length > 0)
  return {
    text,
    commands: mode === 'ai' ? [] : commands,
    mode,
    maxRounds: input.maxRounds ?? defaults.maxRounds,
    maxUsd: input.maxUsd ?? defaults.maxUsd,
    maxHours: input.maxHours ?? defaults.maxHours,
    ...(criteria.length > 0 ? { criteria } : {}),
    ...(input.requireEvidence !== undefined ? { requireEvidence: input.requireEvidence } : {}),
  }
}

const NAMES_MAX = 12
const PATH_CHARS = /^[A-Za-z0-9_./-]+$/
/** A `quoted` path, or a word with a file extension (`README.md`, `src/a.ts`). */
const FILE_TOKEN = /`([^`\n]{1,200})`|([A-Za-z0-9_./-]*[A-Za-z0-9_-]\.[A-Za-z][A-Za-z0-9]{0,7})(?![A-Za-z0-9_])/g

/**
 * The workspace files a goal's text names, as paths relative to `/workspace`: words with a file extension and
 * `quoted` paths. Paths outside the workspace (absolute ones, `..`) are left out. A bare name matches the file in any
 * directory (see `pickNamed` in runner.ts).
 */
export function goalFileNames(text: string): string[] {
  const names: string[] = []
  for (const match of text.matchAll(FILE_TOKEN)) {
    const quoted = match[1] !== undefined
    let name = (match[1] ?? match[2] ?? '').trim()
    if (name.startsWith('/workspace/')) name = name.slice('/workspace/'.length)
    while (name.startsWith('./')) name = name.slice(2)
    if (!name || !PATH_CHARS.test(name) || name.startsWith('/') || name.startsWith('-') || name.endsWith('/')) continue
    if (name.split('/').includes('..')) continue
    // A quoted word is a path only when it looks like one: `pnpm test` and `--top` are not.
    if (quoted && !name.includes('.') && !name.includes('/') && !/^[A-Z][A-Za-z]+$/.test(name)) continue
    if (!names.includes(name)) names.push(name)
    if (names.length >= NAMES_MAX) break
  }
  return names
}

interface GoalState {
  status: GoalStatus
  rounds: number
  roundCap: number
  usdBase: number
  usdCap: number
  startedAt: string
  deadline: string
  checks: GoalCheck[]
  /** The question this goal asked when it last stopped; a reply answers it, though core keeps it open until a report. */
  asked?: string
  /** 若因连续失败触发过模型自动阶梯升级，记录已升级到的模型 ref，避免反复重复切换。 */
  escalatedTo?: string
  /** 本工单收集到的结构化验证证据（测试命令、浏览器自检、文件/Git/数据核对）。 */
  evidences?: VerificationEvidence[]
}
interface Stored { triggerId: string; spec: GoalSpec; state: GoalState; ticket?: GoalTicket }

export class GoalService {
  private readonly select: StatementSync
  private readonly upsert: StatementSync
  private readonly now: () => Date
  /** Tickets whose goal is being checked right now; a second report meanwhile is answered, not checked twice. */
  private readonly checking = new Set<string>()

  constructor(private readonly deps: GoalDeps) {
    deps.db.exec('CREATE TABLE IF NOT EXISTS ticket_goals (trigger_id TEXT PRIMARY KEY, spec TEXT NOT NULL, state TEXT NOT NULL, updated_at TEXT NOT NULL)')
    this.select = deps.db.prepare('SELECT spec, state FROM ticket_goals WHERE trigger_id = ?')
    this.upsert = deps.db.prepare('INSERT OR REPLACE INTO ticket_goals (trigger_id, spec, state, updated_at) VALUES (?, ?, ?, ?)')
    this.now = deps.now ?? (() => new Date())
  }

  /** The goal of a request whose ticket does not exist yet. */
  setPending(triggerId: string, spec: GoalSpec): void {
    this.write({ triggerId, spec, state: this.fresh(spec, 0) })
  }

  /** Gives an existing ticket a goal, replacing any earlier one; rounds, spend and time count from now. */
  set(ticketId: string, spec: GoalSpec): GoalView | undefined {
    const ticket = this.deps.ticket(ticketId)
    if (!ticket) return undefined
    this.write({ triggerId: ticket.triggerId, spec, state: this.fresh(spec, this.spendOf(ticketId)) })
    this.deps.step?.(ticketId, `目标：设定了目标（最多 ${spec.maxRounds} 轮、${money(spec.maxUsd)}、${spec.maxHours} 小时）`, spec.text, 'done')
    this.deps.event?.(ticketId, 'info', `设定了目标：${clip(spec.text, 120)}`)
    if (!ticket.ended) {
      this.deps.notify?.(ticketId, [
        `人给这张任务设了目标，必须达成才算完成：${spec.text}`,
        ...(spec.commands.length > 0 ? [`验收命令：${spec.commands.join('；')}`] : []),
        '报 ready 时宿主会先检查，没达成任务不会结束。',
      ].join('\n'))
    }
    return this.view(ticketId)
  }

  /** Drops an open goal; the ticket then ends like any other. */
  cancel(ticketId: string): boolean {
    const found = this.load(ticketId)
    if (!found || (found.state.status !== 'active' && found.state.status !== 'paused')) return false
    found.state.status = 'cancelled'
    this.write(found)
    this.deps.step?.(ticketId, '目标：已取消，之后按普通任务结束', '', 'done')
    this.deps.event?.(ticketId, 'info', '取消了目标')
    if (found.ticket && !found.ticket.ended && !found.ticket.waitsForPerson) {
      this.deps.notify?.(ticketId, '人取消了这张任务的目标。照常完成并用 sa_report 汇报即可。')
    }
    return true
  }

  view(ticketId: string): GoalView | undefined {
    const found = this.load(ticketId)
    if (!found) return undefined
    const { spec, state } = found
    const last = state.checks.at(-1)
    return {
      ...spec,
      status: state.status,
      rounds: state.rounds,
      roundCap: state.roundCap,
      usdUsed: Math.max(0, this.spendOf(ticketId) - state.usdBase),
      usdCap: state.usdCap,
      startedAt: state.startedAt,
      deadline: state.deadline,
      checking: this.checking.has(ticketId),
      ...(last ? { last } : {}),
      checks: state.checks.slice(-8),
      ...(state.evidences && state.evidences.length > 0 ? { evidences: state.evidences.slice(-30) } : {}),
      ...(state.escalatedTo ? { escalatedTo: state.escalatedTo } : {}),
    }
  }

  /** 为工单登记一条结构化验证证据（如 `browser_verify` 浏览器断言、数据核对、文件校验、Git 检查）。 */
  recordEvidence(
    ticketId: string,
    input: Omit<VerificationEvidence, 'id' | 'at'> & { at?: string },
  ): VerificationEvidence | undefined {
    const found = this.load(ticketId)
    const entry: VerificationEvidence = {
      id: `ev_${randomBytes(4).toString('hex')}`,
      kind: input.kind,
      ...(input.criterionId ? { criterionId: input.criterionId } : {}),
      runId: input.runId,
      artifactVersion: input.artifactVersion || 'working-tree',
      passed: input.passed,
      summary: clip(input.summary, 400),
      ...(input.detail ? { detail: clip(input.detail, 2000) } : {}),
      at: input.at ?? this.now().toISOString(),
    }
    if (!found) {
      // 即使工单未提前设定 Goal，也建一条轻量独立证据表记录以便交付回执展示
      this.storeStandaloneEvidence(ticketId, entry)
      return entry
    }
    found.state.evidences = [...(found.state.evidences ?? []), entry].slice(-60)
    this.write(found)
    return entry
  }

  /** 读取工单收集到的全部结构化证据（含 Goal 证据与独立证据）。 */
  listEvidences(ticketId: string): VerificationEvidence[] {
    const found = this.load(ticketId)
    const fromGoal = found?.state.evidences ?? []
    const standalone = this.readStandaloneEvidences(ticketId)
    const byId = new Map<string, VerificationEvidence>()
    for (const ev of [...standalone, ...fromGoal]) byId.set(ev.id, ev)
    return [...byId.values()].sort((a, b) => a.at.localeCompare(b.at))
  }

  /** 生成面向用户的结构化交付回执：交付物、逐条验收结果、证据及是否需要人工决定。 */
  buildReceipt(
    ticketId: string,
    opts: {
      deliverables: { path: string; size?: number; kind?: string }[]
      contractVersion?: number | null
      contractCriteria?: readonly ContractCriterion[]
      needsPerson?: boolean
      question?: string
      ended?: boolean
      outcome?: string
    },
  ): DeliveryReceipt {
    const view = this.view(ticketId)
    const evidences = this.listEvidences(ticketId)
    const criteriaList = opts.contractCriteria && opts.contractCriteria.length > 0
      ? opts.contractCriteria
      : (view?.criteria ?? [])

    const evaluatedCriteria = criteriaList.map(c => {
      const matched = evidences.filter(ev => ev.criterionId === c.id)
      const latest = matched.at(-1)
      let status: 'passed' | 'failed' | 'pending' = 'pending'
      if (latest) status = latest.passed ? 'passed' : 'failed'
      else if (view?.status === 'met') status = 'passed'
      else if (view?.last && !view.last.met) status = 'failed'
      return { id: c.id, text: c.text, required: c.required, status, evidences: matched }
    })

    const pendingItems: string[] = []
    for (const c of evaluatedCriteria) {
      if (c.required && c.status !== 'passed') pendingItems.push(`待完成条件「${c.text}」（当前：${c.status === 'failed' ? '未通过' : '待验证'}）`)
    }
    if (view?.last && !view.last.met) {
      for (const m of this.missing(view.last)) {
        if (!pendingItems.includes(m)) pendingItems.push(m)
      }
    }
    const failedEv = evidences.filter(e => !e.passed)
    if (failedEv.length > 0 && pendingItems.length === 0) {
      for (const fe of failedEv.slice(-3)) pendingItems.push(`未通过证据（${fe.kind}）：${fe.summary}`)
    }

    let status: DeliveryReceipt['status'] = 'pending'
    if (opts.outcome === 'failed' || opts.outcome === 'dropped' || evaluatedCriteria.some(c => c.required && c.status === 'failed') || (view?.last && !view.last.met && view.status !== 'met')) {
      status = evaluatedCriteria.some(c => c.status === 'passed') ? 'partial' : 'failed'
    } else if (view?.status === 'met' || (evaluatedCriteria.length > 0 && evaluatedCriteria.every(c => !c.required || c.status === 'passed')) || (opts.ended && (opts.outcome === 'completed' || opts.outcome === 'merged') && !view)) {
      status = 'verified'
    } else if (evaluatedCriteria.some(c => c.status === 'passed')) {
      status = 'partial'
    }

    const needsDecision = Boolean(opts.needsPerson || view?.status === 'paused')
    const decisionPrompt = opts.question || view?.last?.paused

    return {
      ticketId,
      contractVersion: opts.contractVersion ?? null,
      status,
      deliverables: opts.deliverables,
      criteria: evaluatedCriteria,
      evidences,
      pendingItems,
      needsDecision,
      ...(decisionPrompt ? { decisionPrompt } : {}),
      generatedAt: this.now().toISOString(),
    }
  }

  private ensureEvidenceTable(): void {
    this.deps.db.exec(`
      CREATE TABLE IF NOT EXISTS ticket_evidences (
        id TEXT PRIMARY KEY,
        ticket_id TEXT NOT NULL,
        value TEXT NOT NULL,
        at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_ticket_evidences_ticket ON ticket_evidences(ticket_id, at ASC);
    `)
  }

  private storeStandaloneEvidence(ticketId: string, ev: VerificationEvidence): void {
    this.ensureEvidenceTable()
    this.deps.db.prepare('INSERT OR REPLACE INTO ticket_evidences (id, ticket_id, value, at) VALUES (?, ?, ?, ?)')
      .run(ev.id, ticketId, JSON.stringify(ev), ev.at)
  }

  private readStandaloneEvidences(ticketId: string): VerificationEvidence[] {
    try {
      this.ensureEvidenceTable()
      const rows = this.deps.db.prepare('SELECT value FROM ticket_evidences WHERE ticket_id = ? ORDER BY at ASC LIMIT 60')
        .all(ticketId) as unknown as { value: string }[]
      return rows.map(r => JSON.parse(r.value) as VerificationEvidence)
    } catch {
      return []
    }
  }

  /** Whether a goal check is running for the ticket: the worker waits on it, so its silence is not a hang. */
  isChecking(ticketId: string): boolean {
    return this.checking.has(ticketId)
  }

  /** For the live board: cheap, and only changes when a round is used. */
  brief(ticketId: string): { status: GoalStatus; rounds: number; roundCap: number } | undefined {
    const found = this.load(ticketId)
    return found ? { status: found.state.status, rounds: found.state.rounds, roundCap: found.state.roundCap } : undefined
  }

  /** Added to the worker's system prompt on each launch while the goal is pursued. */
  systemPrompt(ticketId: string): string | undefined {
    const found = this.load(ticketId)
    if (!found || found.state.status !== 'active') return undefined
    const { spec, state } = found
    const how = spec.mode === 'commands' ? '跑验收命令'
      : spec.mode === 'ai' ? '让判定模型逐条核对目标'
        : '先跑验收命令，全部通过后再让判定模型逐条核对目标'
    return [
      '## 这张任务的目标',
      '这张任务设了目标，必须达成才算完成：',
      spec.text,
      ...(spec.commands.length > 0
        ? ['', '验收命令（宿主会在你的工作区 /workspace 里逐条运行，全部退出码为 0 才算通过）：', ...spec.commands.map(command => `- ${command}`)]
        : []),
      '',
      `你用 sa_report 报 ready 时，宿主会先检查：${how}。没通过就会告诉你差在哪里，任务不会结束；报 failed 或 dropped 也一样会被检查。`,
      `所以请先自己确认达成${spec.commands.length > 0 ? '（自己跑一遍验收命令）' : ''}，再报 ready。需要人回答的问题，用 blocked 加 question 问。`,
      `上限：最多 ${state.roundCap} 轮检查、${money(state.usdCap)}，到 ${state.deadline} 为止；到了会停下等人。`,
    ].join('\n')
  }

  /** Looks at a worker's report before the Engine does. */
  async gate(ticketId: string, report: WorkerReport): Promise<GateDecision> {
    const found = this.load(ticketId)
    if (!found || (found.state.status !== 'active' && found.state.status !== 'paused')) return PASS
    if (report.state === 'progress' || report.state === 'waiting') return PASS
    // A question for a person goes through: only a person can answer it, and it costs no round.
    if (typeof report.question === 'string' && report.question.trim() !== '') return PASS
    if (found.state.status === 'paused') {
      return { action: 'reply', reply: '目标已经用完上限，停下等人决定。这次汇报没有记下；等人回复后再继续。' }
    }
    if (this.checking.has(ticketId)) return { action: 'reply', reply: '上一次目标检查还没结束。等它的结果，不要重复汇报。' }
    this.checking.add(ticketId)
    try {
      const commands = found.spec.mode === 'ai' ? '' : `，先跑 ${found.spec.commands.length} 条验收命令`
      this.deps.step?.(ticketId, `目标检查：开始核对${commands}`, '', 'done')
      return await this.checkAndDecide(ticketId, found.spec, report)
    } catch (error) {
      this.deps.event?.(ticketId, 'warn', `目标检查出错：${describe(error)}`)
      return { action: 'reply', reply: `目标检查出错了（${describe(error)}），这次汇报没有记下。过一会儿再报一次。` }
    } finally {
      this.checking.delete(ticketId)
    }
  }

  /** A turn settled: a worker that delivered nothing is pushed on, until a cap stops it to ask a person. */
  afterTurn(ticketId: string, turnAt: string | undefined): string | undefined {
    const found = this.load(ticketId)
    if (!found || found.state.status !== 'active' || this.checking.has(ticketId)) return undefined
    const ticket = found.ticket
    if (!ticket || ticket.ended || ticket.waitsForPerson || ticket.undelivered > 0) return undefined
    // An open question waits for a person; the one this goal asked when it stopped was answered by the reply that resumed it.
    if (ticket.question !== undefined && ticket.question !== found.state.asked) return undefined
    const report = ticket.report
    // Waiting for a follow-up is a deliberate pause; a final report made in this turn already went through the gate.
    if (report?.state === 'waiting') return undefined
    if (report && report.state !== 'progress' && turnAt !== undefined && report.at >= turnAt) return undefined
    const { spec, state } = found
    // A turn that already got a check's feedback used its round there; pushing it on again costs no second round.
    const previous = state.checks.at(-1)
    const checkedThisTurn = turnAt !== undefined && previous?.kind === 'check' && previous.at >= turnAt
    if (!checkedThisTurn) state.rounds += 1
    const check: GoalCheck = { at: this.now().toISOString(), round: state.rounds, kind: 'nudge', met: false, summary: '这一轮结束了，但没有交付', commands: [] }
    const why = this.limit(ticketId, spec, state)
    if (why !== undefined) {
      check.paused = why
      state.status = 'paused'
      const pause = this.pauseReport(spec, check, why)
      state.asked = pause.question
      this.push(state, check)
      this.write(found)
      this.deps.step?.(ticketId, `目标：这一轮没交付，${why}，停下等你`, '', 'error')
      this.deps.event?.(ticketId, 'warn', `目标没达成，${why}，已停下等人`)
      try {
        this.deps.report(ticketId, pause)
      } catch (error) {
        this.deps.event?.(ticketId, 'warn', `目标停下时没能记下报告：${describe(error)}`)
      }
      return undefined
    }
    this.push(state, check)
    this.write(found)
    this.deps.step?.(ticketId, `目标：这一轮没交付，推它继续（第 ${state.rounds}/${state.roundCap} 轮）`, '', 'done')
    return [
      `这一轮结束了，但目标还没达成，任务不能就此停下（第 ${state.rounds}/${state.roundCap} 轮）。`,
      `目标：${spec.text}`,
      ...(spec.commands.length > 0 ? ['验收命令：', ...spec.commands.map(command => `- ${command}`)] : []),
      '请接着干。确认达成后用 sa_report 报 ready，宿主会先检查；需要人回答的问题，用 blocked 加 question 问。',
    ].join('\n')
  }

  /** A person wrote on the ticket: a goal that stopped at a cap gets another batch of rounds, spend and time. */
  personReplied(ticketId: string): boolean {
    const found = this.load(ticketId)
    if (!found || found.state.status !== 'paused') return false
    const { spec, state } = found
    const used = Math.max(0, this.spendOf(ticketId) - state.usdBase)
    state.status = 'active'
    state.roundCap = state.rounds + spec.maxRounds
    state.usdCap = Number((used + spec.maxUsd).toFixed(4))
    state.deadline = new Date(this.now().getTime() + spec.maxHours * 3_600_000).toISOString()
    this.write(found)
    this.deps.step?.(ticketId, `目标：你回复后接着干，再给 ${spec.maxRounds} 轮`, '', 'done')
    this.deps.event?.(ticketId, 'info', `目标继续，再给 ${spec.maxRounds} 轮`)
    return true
  }

  private async checkAndDecide(ticketId: string, spec: GoalSpec, report: WorkerReport): Promise<GateDecision> {
    const check = await this.check(ticketId, spec, report.summary)
    // The goal may have been changed or cancelled while the commands ran.
    const current = this.load(ticketId)
    if (!current || current.state.status !== 'active') return PASS
    if (JSON.stringify(current.spec) !== JSON.stringify(spec)) {
      return { action: 'reply', reply: '检查期间目标被人改了，这次汇报没有记下。按新目标确认达成后，再报一次 ready。' }
    }
    const { state } = current
    if (check.met) {
      check.round = state.rounds
      state.status = 'met'
      this.push(state, check)
      this.write(current)
      this.deps.step?.(ticketId, `目标检查：已达成。${check.summary}`, this.detail(check), 'done')
      this.deps.event?.(ticketId, 'info', `目标已达成：${clip(check.summary, 160)}`)
      if (report.state === 'ready') return PASS
      return { action: 'replace', report: { state: 'ready', summary: report.summary }, reply: '目标检查通过，任务按完成结束。' }
    }
    state.rounds += 1
    check.round = state.rounds
    const why = this.limit(ticketId, spec, state)
    if (why !== undefined) {
      check.paused = why
      state.status = 'paused'
      const pause = this.pauseReport(spec, check, why)
      state.asked = pause.question
      this.push(state, check)
      this.write(current)
      this.deps.step?.(ticketId, `目标检查：没通过，${why}，停下等你`, this.detail(check), 'error')
      this.deps.event?.(ticketId, 'warn', `目标没达成，${why}，已停下等人`)
      return { action: 'replace', report: pause, reply: `目标检查没通过，并且${why}。任务已停下等人决定，不要再改动，等人回复。` }
    }
    this.push(state, check)
    let escalationNote = ''
    // 连续 2 轮检查未通过或重复出现同类错误时，先分类根因：
    // 信息不足 → 直接提问用户；环境问题 → 提示修环境；仅推理受阻且预算允许时才升级模型！
    const diagnosis = classifyGoalFailure(state.checks)
    check.diagnosis = diagnosis
    if (state.rounds >= 2) {
      if (diagnosis.category === 'need_info') {
        state.status = 'paused'
        const q = `目标连续 ${state.rounds} 轮受阻，原因判定为缺少前提信息/凭据：${diagnosis.reason}。请补充相关信息或授权后回复继续。`
        state.asked = q
        this.write(current)
        this.deps.step?.(ticketId, '失败分类：信息不足，暂停并向主人提问', diagnosis.reason, 'error')
        this.deps.event?.(ticketId, 'warn', `失败原因分类为信息不足，已停止盲目重试并向主人提问`)
        return {
          action: 'replace',
          report: { state: 'blocked', summary: clip(`缺少必要信息/凭据，已停下向主人确认：${diagnosis.reason}`, 600), question: clip(q, 900) },
          reply: `系统判断当前阻塞属于【信息/凭据不足】，已暂停并向主人发起提问，请等待主人回复。`,
        }
      }
      if (diagnosis.category === 'env_error') {
        escalationNote = `\n\n[失败诊断：环境/依赖异常] ${diagnosis.reason}。请优先检查依赖、权限、网络或容器环境（不要盲目重复同样命令）；若确实缺系统包请在汇报中写明包名。`
        this.deps.step?.(ticketId, '失败分类：环境异常，建议先修环境而非换模型', diagnosis.reason, 'error')
      } else if (!state.escalatedTo && this.deps.escalateModel) {
        const remainingUsd = Math.max(0, state.usdCap - (this.spendOf(ticketId) - state.usdBase))
        if (remainingUsd > 0.05) {
          try {
            const escalated = await this.deps.escalateModel(ticketId, {
              round: state.rounds,
              reason: diagnosis.reason,
              diagnosis,
              remainingUsd,
              previousAttempts: state.checks.slice(-4).map(c => `第${c.round}轮: ${c.summary}`),
              evidences: this.listEvidences(ticketId).slice(-10),
              latestSummary: report.summary,
            })
            if (escalated && escalated.to !== escalated.from) {
              state.escalatedTo = escalated.to
              escalationNote = `\n\n[智能模型升级] 经失败诊断属于推理受阻（剩余预算 ${money(remainingUsd)}），已自动从 ${escalated.from} 升级至更强模型 ${escalated.to}，并已保留已有成果与全部失败证据继续破局。`
              this.deps.step?.(ticketId, `模型智能升级：${escalated.from} → ${escalated.to}`, diagnosis.reason, 'done')
              this.deps.event?.(ticketId, 'info', `推理受阻（第 ${state.rounds} 轮），预算内自动升级模型：${escalated.from} → ${escalated.to}`)
            }
          } catch {
            // 升级为尽力优化，失败不影响正常反馈流程
          }
        }
      }
    }
    this.write(current)
    this.deps.step?.(ticketId, `目标检查：没通过（第 ${state.rounds}/${state.roundCap} 轮）。${check.summary}`, this.detail(check), 'error')
    // Clearing the question this goal asked when it stopped: the person answered it by resuming the goal.
    const stale = current.ticket?.question !== undefined && current.ticket.question === state.asked
    return {
      action: 'replace',
      report: { state: 'progress', summary: clip(`目标检查没通过（第 ${state.rounds}/${state.roundCap} 轮）：${check.summary}`, 600), ...(stale ? { question: null } : {}) },
      reply: `${this.feedback(spec, state, check)}${escalationNote}`,
    }
  }

  private async check(ticketId: string, spec: GoalSpec, summary: string): Promise<GoalCheck> {
    const at = this.now().toISOString()
    const runId = `chk_${randomBytes(4).toString('hex')}`
    const artifactVersion = this.deps.artifactVersion
      ? await Promise.resolve(this.deps.artifactVersion(ticketId)).catch(() => 'working-tree')
      : 'working-tree'
    const timeoutSec = this.deps.settings().commandTimeoutSec
    const commands: CommandResult[] = []
    const checkEvidences: VerificationEvidence[] = []

    if (spec.mode !== 'ai') {
      const started = Date.now()
      for (const command of spec.commands) {
        if (Date.now() - started > COMMANDS_BUDGET_MS) {
          commands.push({ command, code: -1, ms: 0, tail: '没有运行：这次检查的验收命令总时长已超过 15 分钟' })
          continue
        }
        try {
          commands.push(await this.deps.run(ticketId, command, timeoutSec))
        } catch (error) {
          commands.push({ command, code: -1, ms: 0, tail: describe(error) })
        }
      }
      for (const c of commands) {
        checkEvidences.push({
          id: `ev_${randomBytes(4).toString('hex')}`,
          kind: 'command',
          runId,
          artifactVersion,
          passed: c.code === 0,
          summary: `${c.code === 0 ? '通过' : '失败'}：$ ${clip(c.command, 120)}（退出码 ${c.code}）`,
          ...(c.tail ? { detail: clip(c.tail, 800) } : {}),
          at,
        })
      }
    }

    // 读取本工单已登记的外部结构化证据（如 browser_verify 浏览器断言 / 数据核对结果）
    const externalEvidences = this.listEvidences(ticketId)
    const failedExternal = externalEvidences.filter(e => e.kind === 'browser' && !e.passed)
    const latestBrowser = externalEvidences.filter(e => e.kind === 'browser').at(-1)
    // 检查是否有必选验收条件关联了未通过的结构化证据
    const failedRequiredCriteria: string[] = []
    for (const crit of spec.criteria ?? []) {
      if (!crit.required) continue
      const bound = externalEvidences.filter(e => e.criterionId === crit.id)
      const latestForCrit = bound.at(-1)
      if (latestForCrit && !latestForCrit.passed) {
        failedRequiredCriteria.push(`[${crit.id}] ${crit.text}（${latestForCrit.summary}）`)
      }
    }

    const base = { at, round: 0, kind: 'check' as const, commands, evidences: checkEvidences }
    const failed = commands.filter(item => item.code !== 0)
    if (failed.length > 0) {
      this.appendEvidences(ticketId, checkEvidences)
      return { ...base, met: false, summary: `${failed.length} 条验收命令没通过：${clip(failed.map(item => item.command).join('；'), 300)}` }
    }
    // 若最近一次浏览器自检失败，绝不放行通过！
    if (latestBrowser && !latestBrowser.passed) {
      this.appendEvidences(ticketId, checkEvidences)
      return {
        ...base,
        met: false,
        summary: `浏览器自检未通过：${clip(latestBrowser.summary, 240)}`,
        verdict: {
          met: false,
          evidence: [],
          missing: [`修复浏览器自检失败项并重新通过 browser_verify：${latestBrowser.summary}`],
          summary: `浏览器自检未通过（${failedExternal.length} 条失败记录）`,
        },
      }
    }
    if (failedRequiredCriteria.length > 0) {
      this.appendEvidences(ticketId, checkEvidences)
      return {
        ...base,
        met: false,
        summary: `必选验收条件未通过：${clip(failedRequiredCriteria.join('；'), 240)}`,
        verdict: {
          met: false,
          evidence: [],
          missing: failedRequiredCriteria.map(x => `修复必选条件并补充通过证据：${x}`),
          summary: `${failedRequiredCriteria.length} 条必选验收条件验证失败`,
        },
      }
    }

    if (spec.mode === 'commands') {
      this.appendEvidences(ticketId, checkEvidences)
      return { ...base, met: true, summary: `${commands.length} 条验收命令全部通过` }
    }

    const names = goalFileNames(spec.text)
    const [context, files] = await Promise.all([
      this.deps.context ? this.deps.context(ticketId).catch(() => '') : Promise.resolve(''),
      names.length > 0 && this.deps.files ? this.deps.files(ticketId, names).catch(() => undefined) : Promise.resolve(undefined),
    ])
    // 把外部浏览器/数据核对证据也透传给裁判参考
    const evContext = externalEvidences.length > 0
      ? `\n\n## 已采集的客观验证证据\n${externalEvidences.slice(-8).map(e => `- [${e.kind}|${e.passed ? '通过' : '失败'}|run=${e.runId}|ver=${e.artifactVersion}] ${e.summary}`).join('\n')}`
      : ''
    const input: JudgeInput = {
      ticketId,
      goal: spec,
      summary,
      commands,
      context: `${context}${evContext}`,
      ...(files ? { files } : {}),
    }
    const seen = files && files.length > 0 ? { files: files.map(file => file.path) } : {}
    let judged = await this.judge(input)
    if (!judged.ok) judged = await this.judge(input)
    if (!judged.ok) {
      this.appendEvidences(ticketId, checkEvidences)
      return { ...base, ...seen, met: false, error: judged.error, summary: `判定模型出错，没能核对：${clip(judged.error, 200)}` }
    }
    let { verdict } = judged

    // 【关键修复 Bug 1】裁判只返回 {"met":true} 没有任何证据，且无通过的命令/外部硬证据时，绝不允许需要证据的任务凭空通过！
    const requireEvidence = spec.requireEvidence !== false
    const hasHardEvidence = commands.some(c => c.code === 0) || externalEvidences.some(e => e.passed)
    const hasJudgeEvidence = verdict.evidence.some(item => item.trim().length > 0)
    if (verdict.met && requireEvidence && !hasJudgeEvidence && !hasHardEvidence) {
      verdict = {
        met: false,
        evidence: [],
        missing: ['裁判仅返回 met:true 但未提供任何具体验证证据（测试结果、文件核对、浏览器断言或数据校验），拒绝无证据通过'],
        summary: '缺少验证证据，拒绝凭空通过',
      }
    }

    if (verdict.evidence.length > 0) {
      checkEvidences.push({
        id: `ev_${randomBytes(4).toString('hex')}`,
        kind: 'judge',
        runId,
        artifactVersion,
        passed: verdict.met,
        summary: verdict.evidence.slice(0, 3).join('；'),
        at,
      })
    }
    this.appendEvidences(ticketId, checkEvidences)

    const prefix = commands.length > 0 ? '验收命令全部通过；' : ''
    const said = verdict.summary || (verdict.met ? '判定已达成' : verdict.missing[0] ?? '判定还没达成')
    return { ...base, ...seen, met: verdict.met, verdict, summary: clip(`${prefix}${said}`, 300) }
  }

  private appendEvidences(ticketId: string, list: readonly VerificationEvidence[]): void {
    if (list.length === 0) return
    const found = this.load(ticketId)
    if (!found) return
    found.state.evidences = [...(found.state.evidences ?? []), ...list].slice(-60)
    this.write(found)
  }

  private async judge(input: JudgeInput): Promise<JudgeResult> {
    try {
      return await this.deps.judge(input)
    } catch (error) {
      return { ok: false, error: describe(error) }
    }
  }

  /** What the worker still has to do, from the last check. */
  private missing(check: GoalCheck): string[] {
    const failed = check.commands.filter(item => item.code !== 0)
    if (failed.length > 0) return failed.map(item => `验收命令没通过：${item.command}（退出码 ${item.code}）`)
    if (check.error !== undefined) return [`判定模型出错（${clip(check.error, 200)}），这次没能核对；确认达成后再报一次 ready`]
    if (check.verdict && !check.verdict.met) {
      return check.verdict.missing.length > 0 ? check.verdict.missing : [check.verdict.summary || '判定模型认为还没达成']
    }
    if (check.kind === 'nudge') return ['这一轮结束了，但没有交付']
    return []
  }

  private feedback(spec: GoalSpec, state: GoalState, check: GoalCheck): string {
    const lines = [`目标检查没通过（第 ${state.rounds}/${state.roundCap} 轮），任务还不能结束。`, `目标：${spec.text}`]
    const missing = this.missing(check)
    if (missing.length > 0) lines.push('还差：', ...missing.map(item => `- ${item}`))
    if (check.commands.length > 0) {
      lines.push('验收命令：')
      for (const item of check.commands) {
        lines.push(`${item.code === 0 ? '✓' : '✗'} ${item.command}（退出码 ${item.code}，${(item.ms / 1000).toFixed(1)} 秒）`)
        if (item.code !== 0 && item.tail) lines.push(item.tail.split('\n').map(line => `    ${line}`).join('\n'))
      }
    }
    lines.push(`请先把差的地方改好，自己确认达成后再用 sa_report 报 ready。没有改动就不要重复报 ready。还剩 ${Math.max(0, state.roundCap - state.rounds)} 轮。`)
    return clip(lines.join('\n'), 12_000)
  }

  private pauseReport(spec: GoalSpec, check: GoalCheck, why: string): WorkerReport & { question: string } {
    const missing = clip(this.missing(check).slice(0, 3).join('；') || check.summary, 400)
    return {
      state: 'blocked',
      summary: clip(`目标没达成，${why}，已停下等人。最后一次：${check.summary}`, 600),
      question: clip(`目标还没达成：${why}。最后一次检查还差：${missing}。回复“继续”就再给 ${spec.maxRounds} 轮接着干；也可以发新的指令，或者在任务页取消目标。默认：停在这里等你决定。`, 900),
    }
  }

  private detail(check: GoalCheck): string {
    const lines: string[] = []
    for (const item of check.commands) lines.push(`${item.code === 0 ? '✓' : '✗'} ${item.command}（退出码 ${item.code}）`)
    if (check.files && check.files.length > 0) lines.push(`判定看过的文件：${check.files.join('、')}`)
    if (check.verdict) {
      for (const item of check.verdict.evidence) lines.push(`证据：${item}`)
      for (const item of check.verdict.missing) lines.push(`还差：${item}`)
    }
    if (check.error) lines.push(`判定出错：${check.error}`)
    return lines.join('\n')
  }

  /** Which cap the goal hit, if any. */
  private limit(ticketId: string, spec: GoalSpec, state: GoalState): string | undefined {
    if (state.rounds >= state.roundCap) return `已经用了 ${state.rounds} 轮（上限 ${state.roundCap} 轮）`
    const used = this.spendOf(ticketId) - state.usdBase
    if (used >= state.usdCap) return `这个目标已花 ${money(used)}（上限 ${money(state.usdCap)}）`
    if (this.now().getTime() >= Date.parse(state.deadline)) return `已经到了时限（${spec.maxHours} 小时）`
    return undefined
  }

  private fresh(spec: GoalSpec, usdBase: number): GoalState {
    const at = this.now()
    return {
      status: 'active',
      rounds: 0,
      roundCap: spec.maxRounds,
      usdBase,
      usdCap: spec.maxUsd,
      startedAt: at.toISOString(),
      deadline: new Date(at.getTime() + spec.maxHours * 3_600_000).toISOString(),
      checks: [],
    }
  }

  private push(state: GoalState, check: GoalCheck): void {
    state.checks.push(check)
    if (state.checks.length > CHECKS_KEPT) state.checks.splice(0, state.checks.length - CHECKS_KEPT)
  }

  private spendOf(ticketId: string): number {
    try {
      return this.deps.spend(ticketId)
    } catch {
      return 0
    }
  }

  private load(ticketId: string): Stored | undefined {
    const ticket = this.deps.ticket(ticketId)
    if (!ticket) return undefined
    const stored = this.read(ticket.triggerId)
    return stored ? { ...stored, ticket } : undefined
  }

  private read(triggerId: string): Stored | undefined {
    const row = this.select.get(triggerId) as { spec: string; state: string } | undefined
    if (!row) return undefined
    try {
      return { triggerId, spec: JSON.parse(row.spec) as GoalSpec, state: JSON.parse(row.state) as GoalState }
    } catch {
      return undefined
    }
  }

  private write(stored: Stored): void {
    this.upsert.run(stored.triggerId, JSON.stringify(stored.spec), JSON.stringify(stored.state), this.now().toISOString())
  }
}
