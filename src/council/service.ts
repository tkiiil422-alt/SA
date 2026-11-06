/**
 * Multi-role council: parallel first round, response rounds, then a moderator's task book.
 *
 * Everything that can fail softly does: one seat failing is recorded as `failed` and the council continues, while the
 * moderator is told which seats were absent. Only when no seat could speak, or the moderator itself fails, does the
 * council become `failed`. Each completed speech is persisted immediately, so a poll sees progress as it happens.
 *
 * Cancellation is cooperative: an in-flight upstream call is allowed to finish (its ledger row is still written) but its
 * result is discarded, and no further call is made. `callModel` has no external abort signal, so "ignore the result" is
 * the honest implementation here.
 *
 * No topic text, speech or prompt ever goes into the event log or a console log; error strings are redacted against the
 * topic before they are stored.
 */
import { randomBytes } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { AdminError } from '../admin/host.ts'
import { findModel, type ModelRef, type Options } from '../admin/options.ts'
import { callModel, type ModelCallOptions, type ModelRequest, type ModelTarget } from '../assessor/model-call.ts'
import {
  clampAtBoundary,
  clampChars,
  laterRoundUser,
  moderatorSystem,
  moderatorUser,
  normalizeBrief,
  roundOneUser,
  roleSystem,
} from './prompts.ts'
import { MODERATOR_NAME } from './roles.ts'
import { CouncilStore } from './store.ts'
import type {
  CouncilData,
  CouncilMode,
  CouncilPhase,
  CouncilRecord,
  CouncilRound,
  CouncilSeat,
  CouncilTurn,
  CouncilTurnStatus,
  CouncilUsage,
} from './types.ts'

export const MAX_COUNCIL_TOPIC_CHARS = 10_000
export const MAX_COUNCIL_BRIEF_CHARS = 10_000
/** At most this many councils run at once; the rest wait with phase `queued`. */
export const MAX_ACTIVE_COUNCILS = 2
const DEFAULT_TIMEOUT_MS = 90_000
const COUNCIL_ID = /^c_[A-Za-z0-9]{1,32}$/
const ERROR_CHARS = 300
/** The first round's answers are longer than the change-only answers of later rounds. */
const MODERATOR_MAX_TOKENS = 8000
/** Ceiling for the moderator's budget after a truncated reply is retried once with double the tokens. */
const MODERATOR_MAX_TOKENS_CAP = 16000
const MODERATOR_TRUNCATED_ERROR = '主持人汇总被长度上限截断（已重试一次），请缩短话题，或在设置里减少轮数、每条发言字数后重试。'

export interface CouncilCreateInput {
  mode: CouncilMode
  text: string
  projectId?: string
  ticketId?: string
  rounds?: number
  /** Role ids to use; omitted means every enabled seat. */
  roles?: string[]
  /** Brief mode only: open the ticket from the task book as soon as the moderator finishes. */
  autoStart?: boolean
}

export interface CouncilListItem {
  id: string
  mode: CouncilMode
  status: CouncilRecord['status']
  topic: string
  createdAt: string
  costUsd: number
}

export interface CouncilDetailView {
  id: string
  mode: CouncilMode
  status: CouncilRecord['status']
  phase: CouncilPhase
  topic: string
  projectId?: string
  ticketId?: string
  rounds: CouncilRound[]
  brief?: string
  costUsd: number
  error?: string
  /** The task opens by itself once the task book is ready. */
  autoStart?: boolean
  createdAt: string
  updatedAt: string
}

export interface CouncilServiceOptions {
  /** The SQLite connection shared with the rest of the runtime. */
  db: DatabaseSync
  /** Live options; the council section and the model providers are read on every create and call. */
  options: () => Options
  /** Today's spend from the ledger, council calls included. Omitted in tests that do not exercise the budget. */
  dayUsd?: () => number
  /** Write one ledger row and return its cost in USD. Omitted means the run costs nothing on paper. */
  record?: (entry: CouncilUsage) => number
  /** The event log; only ids, mode, cost and seat count ever reach it. */
  event?: (input: { kind: string; level: 'info' | 'warn'; text: string; data?: unknown }) => void
  /** Throws an `AdminError` 400 when a project cannot be used for a council. */
  requireProject?: (id: string) => void
  /** The project profile text (at most 6 KB), or undefined when there is none. */
  projectProfile?: (id: string) => string | undefined
  /** For `decision` mode: the composed topic (original task + latest report + current question). */
  decisionTopic?: (ticketId: string) => string | undefined
  /** Opens a ticket from a finished task book (auto-start councils). Bound late: the admin host is built after this service. */
  startTicket?: (input: { brief: string; projectId?: string }) => Promise<{ ticketId?: string }>
  now?: () => Date
  /** Test hook: stable ids. */
  idFactory?: () => string
  /** Test hook: a fake call in place of `callModel`. */
  call?: typeof callModel
  /** Test hook: a fake fetch handed to `callModel`. */
  fetch?: typeof fetch
  timeoutMs?: number
  maxActive?: number
  onError?: (error: unknown) => void
}

const describe = (error: unknown): string => error instanceof Error ? error.message : String(error)

function randomId(): string {
  return `c_${randomBytes(6).toString('hex')}`
}

function turnStatus(turns: readonly CouncilTurn[]): CouncilTurnStatus[] {
  return turns.map(turn => turn.status)
}

export class CouncilService {
  private readonly store: CouncilStore
  private readonly options: () => Options
  private readonly dayUsd: () => number
  private readonly recordCost: ((entry: CouncilUsage) => number) | undefined
  private readonly event: CouncilServiceOptions['event']
  private readonly requireProject: ((id: string) => void) | undefined
  private readonly projectProfile: ((id: string) => string | undefined) | undefined
  private readonly decisionTopic: ((ticketId: string) => string | undefined) | undefined
  private readonly startTicket: CouncilServiceOptions['startTicket']
  private readonly now: () => Date
  private readonly idFactory: () => string
  private readonly call: typeof callModel
  private readonly fetchImpl: typeof fetch | undefined
  private readonly timeoutMs: number
  private readonly maxActive: number
  private readonly onError: ((error: unknown) => void) | undefined

  private readonly queue: string[] = []
  private readonly cancelled = new Set<string>()
  private readonly projectText = new Map<string, string>()
  private readonly idleWaiters: (() => void)[] = []
  private active = 0

  constructor(options: CouncilServiceOptions) {
    this.store = new CouncilStore(options.db)
    this.options = options.options
    this.dayUsd = options.dayUsd ?? (() => 0)
    this.recordCost = options.record
    this.event = options.event
    this.requireProject = options.requireProject
    this.projectProfile = options.projectProfile
    this.decisionTopic = options.decisionTopic
    this.startTicket = options.startTicket
    this.now =options.now ?? (() => new Date())
    this.idFactory = options.idFactory ?? randomId
    this.call = options.call ?? callModel
    this.fetchImpl = options.fetch
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.maxActive = Math.max(1, Math.trunc(options.maxActive ?? MAX_ACTIVE_COUNCILS))
    this.onError = options.onError
    // A new process owns no in-flight calls. Rows still marked running were interrupted by the restart.
    try {
      this.store.interruptRunning('守护进程重启，会商中断', this.now().toISOString())
    } catch (error) {
      this.onError?.(error)
    }
  }

  /** No timers are held; pending calls finish or are discarded after cancellation. */
  close(): void {
    this.projectText.clear()
    for (const resolve of this.idleWaiters.splice(0)) resolve()
  }

  // --- Reads ------------------------------------------------------------------------------------------------------

  list(query: { ticketId?: string; limit?: number } = {}): CouncilListItem[] {
    const limit = Math.min(Math.max(Math.trunc(query.limit ?? 50), 1), 200)
    return this.store.list(limit, query.ticketId).map(record => ({
      id: record.id,
      mode: record.mode,
      status: record.status,
      topic: record.topic,
      createdAt: record.createdAt,
      costUsd: record.costUsd,
    }))
  }

  detail(id: string): CouncilDetailView | undefined {
    if (!COUNCIL_ID.test(id)) return undefined
    const record = this.store.get(id)
    if (record === undefined) return undefined
    return {
      id: record.id,
      mode: record.mode,
      status: record.status,
      phase: record.phase,
      topic: record.topic,
      ...(record.projectId === undefined ? {} : { projectId: record.projectId }),
      ...(record.ticketId === undefined ? {} : { ticketId: record.ticketId }),
      rounds: record.data.rounds,
      ...(record.brief === undefined ? {} : { brief: record.brief }),
      costUsd: record.costUsd,
      ...(record.error === undefined ? {} : { error: record.error }),
      ...(record.data.autoStart === true ? { autoStart: true } : {}),
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    }
  }

  /** The council badge for a ticket; the newest one when several exist. */
  forTicket(ticketId: string): { id: string; status: CouncilRecord['status'] } | undefined {
    const record = this.store.forTicket(ticketId)
    return record === undefined ? undefined : { id: record.id, status: record.status }
  }

  get(id: string): CouncilRecord | undefined {
    return COUNCIL_ID.test(id) ? this.store.get(id) : undefined
  }

  // --- Create / cancel / delete -----------------------------------------------------------------------------------

  create(input: CouncilCreateInput): { id: string } {
    const config = this.options()
    if (!config.council.enabled) throw new AdminError('disabled', '会商没有启用，请先在设置→会商里打开。', 400)
    if (input.mode !== 'brief' && input.mode !== 'decision') throw new AdminError('invalid', '会商模式只能是 brief 或 decision。', 400)
    if (input.rounds !== undefined && (!Number.isInteger(input.rounds) || input.rounds < 1 || input.rounds > 3)) {
      throw new AdminError('invalid', '轮数只能是 1、2 或 3。', 400)
    }
    const budget = config.budget
    const spent = this.dayUsd()
    if (budget.dailyUsd > 0 && spent >= budget.dailyUsd) {
      throw new AdminError(
        'budget',
        `今天已花 $${spent.toFixed(4)}，达到每日上限 $${budget.dailyUsd.toFixed(2)}，暂时不能召集会商；可在设置→预算里调高上限。`,
        400,
      )
    }

    // A decision topic is composed from the ticket itself; the caller's text is only a fallback.
    const composed = input.mode === 'decision' && input.ticketId !== undefined
      ? this.decisionTopic?.(input.ticketId)
      : undefined
    const topic = clampChars((composed ?? input.text).trim(), MAX_COUNCIL_TOPIC_CHARS)
    if (topic === '') throw new AdminError('invalid', '会商话题不能为空。', 400)
    if ((composed ?? input.text).trim().length > MAX_COUNCIL_TOPIC_CHARS && composed === undefined) {
      throw new AdminError('invalid', '会商话题不能超过 10000 字，请精简后再召集会商。', 400)
    }
    if (input.projectId !== undefined) {
      if (this.requireProject === undefined) throw new AdminError('invalid', '这台服务器没有启用项目库。', 400)
      this.requireProject(input.projectId)
    }

    const setup = this.resolveSetup(config, input.roles)
    const planned = input.rounds ?? config.council.rounds
    const data: CouncilData = {
      roundsPlanned: planned,
      seats: setup.seats,
      rounds: Array.from({ length: planned }, (_, index) => ({
        n: index + 1,
        turns: setup.seats.map(seat => ({ roleId: seat.id, name: seat.name, status: 'pending' as const, text: '', ms: 0, costUsd: 0 })),
      })),
      moderator: setup.moderator,
      ...(input.mode === 'brief' && input.autoStart === true ? { autoStart: true } : {}),
    }

    let id = this.idFactory()
    for (let attempt = 0; attempt < 5 && this.store.get(id) !== undefined; attempt += 1) id = this.idFactory()
    if (this.store.get(id) !== undefined) throw new AdminError('internal', '无法分配会商编号，请重试。', 500)

    const at = this.now().toISOString()
    this.store.insert({
      id,
      mode: input.mode,
      status: 'running',
      phase: 'queued',
      topic,
      ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
      ...(input.ticketId === undefined ? {} : { ticketId: input.ticketId }),
      data,
      costUsd: 0,
      createdAt: at,
      updatedAt: at,
    })
    if (input.projectId !== undefined && this.projectProfile !== undefined) {
      const profile = this.projectProfile(input.projectId)
      if (profile !== undefined) this.projectText.set(id, profile)
    }
    this.enqueue(id)
    return { id }
  }

  cancel(id: string): void {
    const record = this.store.get(id)
    if (record === undefined) throw new AdminError('not_found', '找不到这次会商。', 404)
    if (record.status !== 'running') return
    this.cancelled.add(id)
    const index = this.queue.indexOf(id)
    if (index >= 0) this.queue.splice(index, 1)
    this.store.update(id, { status: 'cancelled', updatedAt: this.now().toISOString() })
  }

  remove(id: string): boolean {
    if (!COUNCIL_ID.test(id)) return false
    const record = this.store.get(id)
    if (record === undefined) return false
    if (record.status === 'running') this.cancel(id)
    this.store.delete(id)
    this.projectText.delete(id)
    return true
  }

  /** Remember an edited task book, so the detail view shows what was actually used for the ticket. */
  rememberBrief(id: string, brief: string): void {
    this.store.update(id, { brief, updatedAt: this.now().toISOString() })
  }

  attachTicket(id: string, ticketId: string): void {
    this.store.update(id, { ticketId, updatedAt: this.now().toISOString() })
  }

  /** Resolves when no council is running or queued; used by tests and the CLI's smoke runs. */
  whenIdle(): Promise<void> {
    if (this.active === 0 && this.queue.length === 0) return Promise.resolve()
    return new Promise(resolve => this.idleWaiters.push(resolve))
  }

  // --- Scheduler --------------------------------------------------------------------------------------------------

  private enqueue(id: string): void {
    this.queue.push(id)
    this.drain()
  }

  private drain(): void {
    while (this.active < this.maxActive && this.queue.length > 0) {
      const id = this.queue.shift()!
      this.active += 1
      void this.runOne(id)
        .catch(error => {
          const record = this.store.get(id)
          if (record !== undefined && record.status === 'running') {
            this.fail(id, this.sanitize(`会商执行失败：${describe(error)}`, record.topic, record.data))
          }
          this.onError?.(error)
        })
        .finally(() => {
          this.projectText.delete(id)
          this.cancelled.delete(id)
          this.active -= 1
          this.settleIdle()
          this.drain()
        })
    }
    this.settleIdle()
  }

  private settleIdle(): void {
    if (this.active !== 0 || this.queue.length !== 0) return
    for (const resolve of this.idleWaiters.splice(0)) resolve()
  }

  private isCancelled(id: string): boolean {
    if (this.cancelled.has(id)) return true
    const record = this.store.get(id)
    return record === undefined || record.status !== 'running'
  }

  // --- The run ----------------------------------------------------------------------------------------------------

  private async runOne(id: string): Promise<void> {
    const record = this.store.get(id)
    if (record === undefined || record.status !== 'running' || this.cancelled.has(id)) return
    this.emit({
      kind: 'council.started',
      level: 'info',
      text: '会商开始',
      data: { councilId: id, mode: record.mode, costUsd: record.costUsd, roles: record.data.seats.length },
    })

    const config = this.options().council
    const topic = record.topic
    const project = record.projectId === undefined ? undefined : this.projectText.get(id)
    let data = record.data

    for (let n = 1; n <= data.roundsPlanned; n += 1) {
      if (this.isCancelled(id)) return
      this.setPhase(id, `round-${n}`)
      this.markRoundRunning(id, n)
      const previous = data.rounds[n - 2]
      const statuses = await Promise.all(data.seats.map(seat => this.runTurn(id, seat, n, topic, project, previous, config.maxCharsPerTurn)))
      if (this.isCancelled(id)) return

      const latest = this.store.get(id)
      if (latest === undefined) return
      data = latest.data
      const currentRound = data.rounds.find(round => round.n === n)
      const allFailed = currentRound !== undefined && currentRound.turns.length > 0 && turnStatus(currentRound.turns).every(value => value === 'failed')
      if (allFailed) {
        this.fail(id, '所有角色都没能发言，会商无法继续。')
        return
      }
      if (statuses.every(value => value === 'cancelled')) return
    }

    if (this.isCancelled(id)) return
    const current = this.store.get(id)
    if (current === undefined) return
    const lastRound = current.data.rounds.at(-1)
    const absent = current.data.seats
      .filter(seat => {
        const turn = lastRound?.turns.find(item => item.roleId === seat.id)
        return turn === undefined || turn.status !== 'done'
      })
      .map(seat => seat.name)

    this.setPhase(id, 'summary')
    await this.runModerator(id, current, topic, project, absent)
  }

  private async runTurn(
    id: string,
    seat: CouncilSeat,
    n: number,
    topic: string,
    project: string | undefined,
    previous: CouncilRound | undefined,
    maxChars: number,
  ): Promise<CouncilTurnStatus | 'cancelled'> {
    if (this.isCancelled(id)) return 'cancelled'
    this.updateTurn(id, n, seat.id, { status: 'running' }, 0)

    let resolved: { provider: string; model: string; target: ModelTarget }
    try {
      resolved = this.resolveModel(seat.model, `角色「${seat.name}」`)
    } catch (error) {
      this.updateTurn(id, n, seat.id, { status: 'failed' }, 0)
      this.onError?.(error)
      return 'failed'
    }

    const request: ModelRequest = {
      model: resolved.model,
      system: roleSystem(seat, maxChars),
      user: n === 1 ? roundOneUser(topic, project) : laterRoundUser(n, topic, project, previous, seat.id),
      maxTokens: Math.min(6000, Math.max(1500, maxChars * 3)),
    }
    const result = await this.invoke(resolved, request, id)
    const cost = this.record(resolved, result)
    if (this.isCancelled(id)) {
      // The call happened and was billed; the transcript stays untouched after a cancel.
      this.addCost(id, cost)
      return 'cancelled'
    }
    if (!result.ok || result.text.trim() === '') {
      this.updateTurn(id, n, seat.id, { status: 'failed', ms: result.latencyMs, costUsd: Math.max(0, cost) }, cost)
      return 'failed'
    }
    // A speech over the limit, or one cut at the output limit, is clipped at a sentence end and marked as such.
    const full = result.text.trim()
    const overlong = Array.from(full).length > maxChars
    const speech = result.truncated === true || overlong
      ? `${clampAtBoundary(full, maxChars)}（发言过长，已截断）`
      : full
    this.updateTurn(id, n, seat.id, {
      status: 'done',
      text: speech,
      ms: result.latencyMs,
      costUsd: Math.max(0, cost),
    }, cost)
    return 'done'
  }

  private async runModerator(
    id: string,
    record: CouncilRecord,
    topic: string,
    project: string | undefined,
    absent: readonly string[],
  ): Promise<void> {
    let resolved: { provider: string; model: string; target: ModelTarget }
    try {
      resolved = this.resolveModel(record.data.moderator, `「${MODERATOR_NAME}」`)
    } catch (error) {
      this.fail(id, this.sanitize(`主持人汇总失败：${describe(error)}`, topic, record.data))
      return
    }
    const request: ModelRequest = {
      model: resolved.model,
      system: moderatorSystem(record.mode),
      user: moderatorUser(record.mode, topic, project, record.data.rounds, absent),
      maxTokens: MODERATOR_MAX_TOKENS,
    }
    let result = await this.invoke(resolved, request, id)
    let cost = this.record(resolved, result)
    if (!this.isCancelled(id) && result.ok && result.truncated === true) {
      // The reply hit the output limit: retry once with double the budget, and keep the cost of both calls.
      const retry: ModelRequest = { ...request, maxTokens: Math.min(MODERATOR_MAX_TOKENS_CAP, request.maxTokens * 2) }
      result = await this.invoke(resolved, retry, id)
      cost += this.record(resolved, result)
    }
    if (this.isCancelled(id)) {
      this.addCost(id, cost)
      return
    }
    // A cut-off task book is never normalised or stored: it would look complete once the headings are filled in.
    if (result.truncated === true) {
      this.addCost(id, cost)
      this.fail(id, this.sanitize(MODERATOR_TRUNCATED_ERROR, topic, record.data))
      return
    }
    if (!result.ok || result.text.trim() === '') {
      this.addCost(id, cost)
      this.fail(id, this.sanitize(`主持人汇总失败：${result.error ?? '回复为空'}`, topic, record.data))
      return
    }
    const brief = normalizeBrief(result.text, record.mode, topic, absent)
    const latest = this.store.get(id)
    if (latest === undefined) return
    const total = latest.costUsd + Math.max(0, cost)
    this.store.update(id, {
      status: 'done',
      phase: 'done',
      brief,
      costUsd: total,
      error: null,
      updatedAt: this.now().toISOString(),
    })
    this.emit({
      kind: 'council.done',
      level: 'info',
      text: '会商完成',
      data: { councilId: id, mode: latest.mode, costUsd: total, roles: latest.data.seats.length },
    })
    if (latest.mode === 'brief' && latest.data.autoStart === true && latest.ticketId === undefined) {
      await this.autoStartTicket(id, brief, latest.projectId)
    }
  }

  /**
   * Opens the ticket for an auto-start council. A failure leaves the council `done` with its task book, so the person can
   * still press 直接开工; the reason goes to the event log and the record's error field.
   */
  private async autoStartTicket(id: string, brief: string, projectId: string | undefined): Promise<void> {
    if (this.startTicket === undefined) return
    try {
      const result = await this.startTicket({ brief, ...(projectId === undefined ? {} : { projectId }) })
      if (result.ticketId !== undefined) {
        this.attachTicket(id, result.ticketId)
        this.emit({ kind: 'council.started', level: 'info', text: '会商完成，已按任务书开工', data: { councilId: id, ticketId: result.ticketId } })
      }
    } catch (error) {
      const message = `任务书已完成，但自动开工没有成功：${describe(error)}。可以在会商室点「直接开工」再试。`
      this.store.update(id, { error: message.slice(0, 500), updatedAt: this.now().toISOString() })
      this.emit({ kind: 'council.start_failed', level: 'warn', text: '会商完成，自动开工失败', data: { councilId: id } })
      this.onError?.(error)
    }
  }

  /** One upstream call with the council id as the upstream session; never throws. */
  private async invoke(
    resolved: { provider: string; model: string; target: ModelTarget },
    request: ModelRequest,
    id: string,
  ): Promise<{ ok: boolean; text: string; usage?: CouncilUsage['usage']; status?: number; latencyMs: number; error?: string; truncated?: boolean }> {
    const options: ModelCallOptions = {
      timeoutMs: this.timeoutMs,
      sessionId: id,
      ...(this.fetchImpl === undefined ? {} : { fetch: this.fetchImpl }),
    }
    try {
      return await this.call(resolved.target, request, options)
    } catch (error) {
      return { ok: false, text: '', latencyMs: 0, error: describe(error) }
    }
  }

  /** Write the ledger row and return its cost; a ledger failure must not stop the council. */
  private record(resolved: { provider: string; model: string }, result: { ok: boolean; usage?: CouncilUsage['usage']; status?: number; latencyMs: number }): number {
    if (this.recordCost === undefined) return 0
    try {
      return this.recordCost({
        provider: resolved.provider,
        model: resolved.model,
        ...(result.usage === undefined ? {} : { usage: result.usage }),
        latencyMs: result.latencyMs,
        status: result.status ?? 0,
        ok: result.ok,
      })
    } catch (error) {
      this.onError?.(error)
      return 0
    }
  }

  // --- Persistence helpers ----------------------------------------------------------------------------------------

  private setPhase(id: string, phase: CouncilPhase): void {
    this.store.update(id, { phase, updatedAt: this.now().toISOString() })
  }

  private markRoundRunning(id: string, n: number): void {
    const record = this.store.get(id)
    if (record === undefined || record.status !== 'running') return
    const rounds = record.data.rounds.map(round => round.n === n
      ? { ...round, turns: round.turns.map(turn => turn.status === 'pending' ? { ...turn, status: 'running' as const } : turn) }
      : round)
    this.store.update(id, { data: { ...record.data, rounds }, updatedAt: this.now().toISOString() })
  }

  /** Update one turn and add its cost in the same synchronous read-modify-write. */
  private updateTurn(id: string, n: number, roleId: string, patch: Partial<CouncilTurn>, cost: number): void {
    const record = this.store.get(id)
    if (record === undefined) return
    const rounds = record.data.rounds.map(round => round.n === n
      ? { ...round, turns: round.turns.map(turn => turn.roleId === roleId ? { ...turn, ...patch } : turn) }
      : round)
    this.store.update(id, {
      data: { ...record.data, rounds },
      costUsd: record.costUsd + Math.max(0, cost),
      updatedAt: this.now().toISOString(),
    })
  }

  private addCost(id: string, cost: number): void {
    const record = this.store.get(id)
    if (record === undefined) return
    this.store.update(id, { costUsd: record.costUsd + Math.max(0, cost), updatedAt: this.now().toISOString() })
  }

  /**
   * Remove user data from an error string before it is stored or logged: the topic becomes `[话题]`, every stored speech
   * (in full, and line by line) becomes `[发言]`. Upstreams sometimes echo the request body in a failure message.
   */
  private sanitize(message: string, topic: string, data?: CouncilData): string {
    let text = message
    const needle = topic.trim()
    if (needle !== '') text = text.split(needle).join('[话题]')
    for (const round of data?.rounds ?? []) {
      for (const turn of round.turns) {
        const speech = turn.text.trim()
        if (speech === '') continue
        text = text.split(speech).join('[发言]')
        for (const line of speech.split(/\r?\n/)) {
          const trimmed = line.trim()
          if (trimmed.length >= 10) text = text.split(trimmed).join('[发言]')
        }
      }
    }
    return clampChars(text, ERROR_CHARS)
  }

  private fail(id: string, error: string): void {
    const record = this.store.get(id)
    if (record === undefined) return
    if (record.status !== 'running') return
    this.store.update(id, { status: 'failed', error, updatedAt: this.now().toISOString() })
    this.emit({
      kind: 'council.failed',
      level: 'warn',
      text: '会商失败',
      data: { councilId: id, mode: record.mode, costUsd: record.costUsd, roles: record.data.seats.length },
    })
  }

  private emit(input: { kind: string; level: 'info' | 'warn'; text: string; data?: unknown }): void {
    try {
      this.event?.(input)
    } catch (error) {
      this.onError?.(error)
    }
  }

  // --- Settings / model resolution --------------------------------------------------------------------------------

  private resolveSetup(config: Options, requested: readonly string[] | undefined): { seats: CouncilSeat[]; moderator: ModelRef } {
    const moderatorRef = config.council.moderator ?? config.models.routing.worker
    // Validate the moderator even before the first call, so a broken settings entry fails the create with a clear 400.
    this.resolveModel(moderatorRef, `「${MODERATOR_NAME}」`)

    const enabled = config.council.roles.filter(role => role.enabled)
    let chosen = enabled
    if (requested !== undefined) {
      const wanted = [...new Set(requested)]
      const known = new Set(enabled.map(role => role.id))
      const unknown = wanted.filter(id => !known.has(id))
      if (unknown.length > 0) throw new AdminError('invalid', `这些角色不存在或已停用：${unknown.join('、')}`, 400)
      chosen = enabled.filter(role => wanted.includes(role.id))
    }
    if (chosen.length === 0) throw new AdminError('invalid', '至少要启用一个会商角色。', 400)

    const seats = chosen.map(role => {
      const model = role.model ?? moderatorRef
      this.resolveModel(model, `角色「${role.name}」`)
      return {
        id: role.id,
        name: role.name,
        persona: role.persona,
        model: { provider: model.provider, model: model.model },
      }
    })
    return { seats, moderator: { provider: moderatorRef.provider, model: moderatorRef.model } }
  }

  private resolveModel(ref: ModelRef, label: string): { provider: string; model: string; target: ModelTarget } {
    const found = findModel(this.options().models, ref)
    if (found === undefined) {
      throw new AdminError('invalid', `${label}使用的模型不存在，请先在设置→模型里配置。`, 400)
    }
    if (!found.provider.enabled) {
      throw new AdminError('invalid', `${label}使用的模型所在服务商未启用。`, 400)
    }
    return {
      provider: found.provider.id,
      model: found.model.id,
      target: {
        api: found.provider.api,
        baseUrl: found.provider.baseUrl,
        apiKey: found.provider.apiKey,
        ...(found.provider.sessionHeader ? { sessionHeader: found.provider.sessionHeader } : {}),
      },
    }
  }
}
