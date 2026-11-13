/**
 * The Executor for tickets bound to a book: one arc per ticket, written by the deterministic `NovelWriter` inside the
 * daemon, with no container and no shell.
 *
 * It implements the same `Executor` port as Pi and reports only through `EngineForExecutor`, so every rule of the domain
 * core still holds: the Eval decided the ticket, a person's stop ends it, a person's follow-up arrives as an Input, a
 * question for a person is one structured question, and a `ready` report ends the ticket with the arc's result.
 *
 * Launches and deliveries run on their own effect kinds (`novel.launch`, `novel.delivery`), so they never share rows or
 * slot limits with Pi's. The arc loop itself runs detached from the effect row; a host restart is reconciled by `resume`
 * exactly as Pi's is, and the writer continues from its per-step checkpoints on disk.
 */
import type { DatabaseSync } from 'node:sqlite'
import type { Assignment, Ticket, TicketInput } from '../core/model.ts'
import type { EngineForExecutor } from '../core/engine.ts'
import type { Executor, Repositories } from '../core/ports.ts'
import { Later, type Effects } from '../effects/effects.ts'
import { callModel, type ModelTarget } from '../assessor/model-call.ts'
import type { Usage } from '../gateway/usage.ts'
import { BookFiles } from './files.ts'
import type { NovelStore } from './store.ts'
import { ModelFailure, NeedsPerson, NovelWriter, Stopped, bookTotal } from './pipeline.ts'
import type { Ask, ChapterOutcome, Role, WriterOptions } from './pipeline.ts'
import { TriageSchema, extractJson } from './schemas.ts'
import type { Arc, Triage } from './schemas.ts'
import { TRIAGE_SYSTEM, triageUser } from './prompts.ts'
import { currentArc } from './context.ts'

export interface ResolvedModel { provider: string; model: string; target: ModelTarget }

export interface NovelUsage { ticketId: string; provider: string; model: string; status: number; usage?: Usage; latencyMs: number }

export interface NovelExecutorOptions {
  effects: Effects
  engine: () => EngineForExecutor
  atomic: <T>(work: () => T) => T
  afterCommit: (fn: () => void) => void
  tickets: Pick<Repositories['tickets'], 'get' | 'open'>
  triggers: Pick<Repositories['triggers'], 'get'>
  store: NovelStore
  db: DatabaseSync
  /** Directory holding one folder per book. */
  root: string
  /** The model for a role of a book; undefined when none is configured or its provider is off. */
  resolve: (role: Role, bookId: string) => ResolvedModel | undefined
  /** Writes one ledger row and returns its cost in USD. */
  record: (entry: NovelUsage) => number
  /** Whether another call may be made for this ticket, with the reason when not. */
  budget: (ticketId: string) => { ok: true } | { ok: false; why: string }
  /** How many books may be written at once. */
  maxActive: () => number
  writerOptions?: () => Partial<WriterOptions>
  /** Per-call timeout; a long chapter at 8k output tokens takes minutes. Default 6 minutes. */
  timeoutMs?: number
  /** Base delay between retries of a failed model call; multiplied by the attempt. Default 10s. */
  retryMs?: number
  call?: typeof callModel
  fetch?: typeof fetch
  sleep?: (ms: number) => Promise<void>
  now?: () => Date
  onError?: (error: unknown) => void
  /** Optional step sink so the task page can show what the engine is doing. */
  step?: (ticketId: string, summary: string, status?: 'done' | 'error') => void
}

interface Payload { ticketId: string; assignmentId: string }

interface Run {
  assignmentId: string
  stopped: boolean
  inbox: string[]
  done: Promise<void>
}

/** A person's steering note, applied to the chapters up to `untilCh`. */
interface Steer { note: string; untilCh: number }

/** Extra output tokens on every novel call, for a reasoning model's hidden thinking. */
export const REASONING_HEADROOM = 8000
/** How long `close` waits for running arcs to notice the stop before it returns. */
const CLOSE_WAIT_MS = 3_000
const REQUEST_MARK = '要求：'
const INSTRUCTION_MARK = 'Instruction: '
const describe = (error: unknown): string => error instanceof Error ? error.message : String(error)

export class NovelExecutor implements Executor {
  private readonly runs = new Map<string, Run>()
  private readonly steers = new Map<string, Steer>()
  private readonly call: typeof callModel
  private readonly sleep: (ms: number) => Promise<void>
  private readonly now: () => Date
  private closed = false

  constructor(private readonly options: NovelExecutorOptions) {
    this.call = options.call ?? callModel
    this.sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)))
    this.now = options.now ?? (() => new Date())
    options.effects.handle<Payload>('novel.launch', payload => this.launchQueued(payload), { retry: [1_000, 60_000] })
    options.effects.handle<Payload>('novel.delivery', payload => this.deliverQueued(payload), { limit: 4, retry: [500, 10_000], maxAttempts: 6 })
  }

  /** The book a ticket writes, binding a pending trigger to the ticket on first sight. */
  bookOf(ticket: Pick<Ticket, 'id' | 'origin'>): { bookId: string; arc: number } | undefined {
    const bound = this.options.store.byTicket(ticket.id)
    if (bound) return { bookId: bound.bookId, arc: bound.arc }
    const pending = this.options.store.byTrigger(ticket.origin.triggerId)
    if (!pending) return undefined
    if (pending.ticketId === undefined) this.options.store.bindTicket(ticket.origin.triggerId, ticket.id)
    else if (pending.ticketId !== ticket.id) return undefined
    return { bookId: pending.bookId, arc: pending.arc }
  }

  owns(ticket: Pick<Ticket, 'id' | 'origin'>): boolean {
    return this.bookOf(ticket) !== undefined
  }

  /** Whether a book has an arc being written right now. */
  writing(bookId: string): string | undefined {
    for (const [ticketId] of this.runs) if (this.options.store.byTicket(ticketId)?.bookId === bookId) return ticketId
    return undefined
  }

  // --- Executor port --------------------------------------------------------------------------------------------------

  start(ticket: Ticket, assignment: Assignment): void {
    this.options.effects.enqueue<Payload>('novel.launch', ticket.id, { ticketId: ticket.id, assignmentId: assignment.id })
  }

  deliver(ticket: Ticket, assignment: Assignment): void {
    this.options.effects.enqueue<Payload>('novel.delivery', ticket.id, { ticketId: ticket.id, assignmentId: assignment.id })
  }

  stop(ticket: Ticket, assignment: Assignment, _reason: string): void {
    this.options.afterCommit(() => {
      const run = this.runs.get(ticket.id)
      if (run && run.assignmentId === assignment.id) run.stopped = true
    })
  }

  /** Reconciles assignments that were running when the host stopped, as Pi's executor does. */
  resume(): void {
    for (const ticket of this.options.tickets.open()) {
      if (!this.owns(ticket)) continue
      const running = ticket.assignments.find(item => item.state === 'running')
      if (!running) continue
      try {
        this.options.atomic(() => this.options.engine().assignmentInterrupted(ticket.id, running.id))
      } catch { /* the ticket moved on */ }
    }
  }

  async close(): Promise<void> {
    this.closed = true
    const runs = [...this.runs.values()]
    for (const run of runs) run.stopped = true
    // An in-flight model call can run for minutes and its result is discarded anyway; the per-step checkpoints on disk
    // are what a restart resumes from. Wait only briefly so a service stop never hits systemd's stop timeout.
    await Promise.race([
      Promise.allSettled(runs.map(run => run.done)),
      new Promise(resolve => setTimeout(resolve, CLOSE_WAIT_MS).unref()),
    ])
  }

  // --- Effect handlers ------------------------------------------------------------------------------------------------

  private async launchQueued({ ticketId, assignmentId }: Payload): Promise<void> {
    if (this.closed) return
    const ticket = this.options.tickets.get(ticketId)
    const assignment = ticket?.assignments.find(item => item.id === assignmentId)
    if (!ticket || ticket.ended || !assignment || assignment.state === 'ended') return
    const existing = this.runs.get(ticketId)
    if (existing) {
      if (existing.assignmentId === assignmentId) return
      // The previous assignment's loop discards its in-flight call and ends; this one starts after it.
      existing.stopped = true
      throw new Later(2_000)
    }
    if (this.runs.size >= Math.max(1, this.options.maxActive())) throw new Later(30_000)
    const book = this.bookOf(ticket)
    if (!book) {
      this.options.atomic(() => this.options.engine().report(ticketId, { state: 'failed', summary: '这张票没有绑定书，无法写作。' }))
      return
    }
    this.options.atomic(() => this.options.engine().assignmentStarted(ticketId, assignmentId))
    const note = this.requestNote(ticket)
    if (note && !this.steers.has(ticketId)) {
      const files = new BookFiles(this.options.root, book.bookId)
      this.steers.set(ticketId, { note, untilCh: files.readBook().lastChapter + 5 })
    }
    this.begin(ticketId, assignmentId, book.bookId, book.arc, note)
  }

  private async deliverQueued({ ticketId, assignmentId }: Payload): Promise<void> {
    if (this.closed) return
    const ticket = this.options.tickets.get(ticketId)
    if (!ticket || ticket.ended) return
    const assignment = ticket.assignments.find(item => item.id === assignmentId && item.state === 'running')
    if (!assignment) return
    const ids = [...ticket.undelivered]
    if (!ids.length) return
    const texts = ids.map(id => this.personText(ticket.inputs.find(input => input.id === id))).filter((x): x is string => !!x)
    this.options.atomic(() => this.options.engine().inputsDelivered(ticketId, assignmentId, ids))
    this.options.atomic(() => this.options.engine().inputsRead(ticketId, ids))
    const run = this.runs.get(ticketId)
    if (run && run.assignmentId === assignmentId && !run.stopped) {
      run.inbox.push(...texts)
      return
    }
    if (!texts.length) return
    const book = this.bookOf(ticket)
    if (!book) return
    // Idle (paused, blocked or waiting): the person's message decides whether the arc goes on.
    const run2: Run = { assignmentId, stopped: false, inbox: [], done: Promise.resolve() }
    const outcome = await this.handle(ticketId, book.bookId, texts, run2)
    if (outcome !== 'run') return
    if (this.runs.size >= Math.max(1, this.options.maxActive())) {
      this.report(ticketId, { state: 'waiting', summary: '已记下你的要求；另一本书正在写，轮到这本时请再发一句“继续”。' })
      return
    }
    this.begin(ticketId, assignmentId, book.bookId, book.arc)
  }

  /** The text of a person's message carried by an Input, or undefined for anything automatic. */
  private personText(input: TicketInput | undefined): string | undefined {
    if (!input) return undefined
    if (input.kind === 'trigger' && input.human && !input.context) return this.options.triggers.get(input.triggerId)?.text?.trim() || undefined
    if (input.kind === 'text') {
      const at = input.text.lastIndexOf(INSTRUCTION_MARK)
      if (at >= 0) return input.text.slice(at + INSTRUCTION_MARK.length).trim() || undefined
      if (input.text.startsWith('A person sent a new instruction on this ticket: ')) return input.text.slice(48).trim() || undefined
    }
    return undefined
  }

  /** The note the arc request carried after `要求：`, if any. */
  private requestNote(ticket: Ticket): string | undefined {
    const text = this.options.triggers.get(ticket.origin.triggerId)?.text ?? ''
    const at = text.indexOf(REQUEST_MARK)
    if (at < 0) return undefined
    const note = text.slice(at + REQUEST_MARK.length).trim()
    return note || undefined
  }

  // --- The arc loop ---------------------------------------------------------------------------------------------------

  private begin(ticketId: string, assignmentId: string, bookId: string, arcN: number, note?: string): void {
    const run: Run = { assignmentId, stopped: false, inbox: [], done: Promise.resolve() }
    this.runs.set(ticketId, run)
    run.done = this.loop(ticketId, bookId, arcN, run, note)
      .catch(error => this.options.onError?.(error))
      .finally(() => {
        if (this.runs.get(ticketId) === run) this.runs.delete(ticketId)
        try { this.options.atomic(() => this.options.engine().turnEnded(ticketId, assignmentId)) } catch { /* ended */ }
        this.options.effects.kick()
      })
  }

  private writer(ticketId: string, bookId: string, run: Run): NovelWriter {
    return new NovelWriter({
      files: new BookFiles(this.options.root, bookId),
      store: this.options.store,
      db: this.options.db,
      ask: this.asker(ticketId, bookId, run),
      now: this.now,
      options: this.options.writerOptions?.() ?? {},
      checkpoint: () => { if (run.stopped || this.closed) throw new Stopped() },
    })
  }

  private async loop(ticketId: string, bookId: string, arcN: number, run: Run, note?: string): Promise<void> {
    const files = new BookFiles(this.options.root, bookId)
    let writer = this.writer(ticketId, bookId, run)
    let arcCost = 0
    try {
      for (;;) {
        if (run.stopped || this.closed) return
        // Rebuilt every chapter so a settings change (revisions, scores, banned words) applies from the next chapter.
        writer = this.writer(ticketId, bookId, run)
        if (run.inbox.length) {
          const outcome = await this.handle(ticketId, bookId, run.inbox.splice(0), run)
          if (outcome !== 'run') return
        }
        const book = files.readBook()
        const n = book.lastChapter + 1
        let arc: Arc | undefined = currentArc(files.readCanon(), n)
        if (!arc) {
          const target = files.readCanon().plan.arcs.find(item => item.n === arcN)
          if (target?.status === 'done') {
            this.report(ticketId, { state: 'ready', summary: `第${arcN}弧已经写完。` })
            return
          }
          arc = await writer.nextArc(note)
          if (arc.n > arcN) {
            this.report(ticketId, { state: 'ready', summary: `第${arcN}弧已经写完。` })
            return
          }
        }
        const steer = this.steers.get(ticketId)
        const steerNote = steer && n <= steer.untilCh ? steer.note : undefined
        const outcome = await writer.writeChapter(arc, steerNote)
        arcCost += outcome.costUsd
        const end = (arc.startCh ?? n) + arc.chapters - 1
        if (outcome.n < end) {
          this.report(ticketId, { state: 'progress', summary: this.progressLine(arc, outcome, end) })
          continue
        }
        const closed = await writer.closeArc(arc)
        // The finale arc ends at the book's planned length: the book is complete and no further arc is opened.
        const complete = files.readBook().lastChapter >= bookTotal(files.readBook())
        if (arc.n < arcN && !complete) continue
        files.writeBook({ ...files.readBook(), phase: complete ? 'done' : 'ready', updatedAt: this.now().toISOString() })
        if (complete) {
          this.report(ticketId, {
            state: 'ready',
            summary: `《${book.title}》全书完本，共 ${outcome.n} 章。最后一弧《${arc.title}》本轮约 $${arcCost.toFixed(3)}。\n\n${closed.summary}`.slice(0, 2000),
          })
          return
        }
        const flagged = closed.flagged.length
          ? `\n\n需要你看的章节：${closed.flagged.map(item => `第${item.n}章《${item.title}》`).join('、')}`
          : ''
        const notes = closed.notes.length ? `\n\n提醒：${closed.notes.join('；')}` : ''
        this.report(ticketId, {
          state: 'ready',
          summary: `《${book.title}》第${arc.n}弧《${arc.title}》写完，共 ${closed.chapters} 章（到第${outcome.n}章），本轮约 $${arcCost.toFixed(3)}。\n\n${closed.summary}${flagged}${notes}`.slice(0, 2000),
        })
        return
      }
    } catch (error) {
      if (error instanceof Stopped) return
      if (error instanceof NeedsPerson) {
        this.report(ticketId, { state: 'blocked', summary: error.summary.slice(0, 2000), question: error.question.slice(0, 1000) })
        return
      }
      const summary = error instanceof ModelFailure ? error.message : `写作出错：${describe(error)}`
      this.report(ticketId, { state: 'failed', summary: summary.slice(0, 2000) })
      if (!(error instanceof ModelFailure)) this.options.onError?.(error)
    }
  }

  private progressLine(arc: Arc, outcome: ChapterOutcome, end: number): string {
    const flag = outcome.status === 'flagged' ? '，已标记待看' : ''
    const score = outcome.score === null ? '' : `，审稿 ${outcome.score} 分`
    return `第${outcome.n}章《${outcome.title}》已提交，${outcome.chars} 字${score}${flag}，$${outcome.costUsd.toFixed(4)}（第${arc.n}弧到第${end}章）`
  }

  private report(ticketId: string, report: { state: 'progress' | 'waiting' | 'ready' | 'blocked' | 'failed'; summary: string; question?: string }): void {
    try {
      this.options.atomic(() => this.options.engine().report(ticketId, report))
    } catch (error) {
      // A ticket a person stopped in the meantime takes no report.
      this.options.onError?.(error)
    }
  }

  // --- A person's messages ----------------------------------------------------------------------------------------

  /** Triage each message and act on it; `run` means the arc may go on. */
  private async handle(ticketId: string, bookId: string, texts: string[], run: Run): Promise<'run' | 'stop'> {
    const files = new BookFiles(this.options.root, bookId)
    for (const text of texts) {
      const book = files.readBook()
      let triage: Triage
      try {
        triage = await this.triage(ticketId, bookId, run, text, book.title, book.lastChapter)
      } catch (error) {
        if (error instanceof Stopped) return 'stop'
        triage = { kind: 'steer', note: text.slice(0, 500), chapters: 5 }
      }
      switch (triage.kind) {
        case 'steer':
        case 'answer': {
          const note = triage.kind === 'steer' ? triage.note : triage.note || text
          this.steers.set(ticketId, { note: note.slice(0, 500), untilCh: book.lastChapter + (triage.kind === 'steer' ? triage.chapters : 5) })
          break
        }
        case 'rewrite': {
          try {
            const moved = this.writer(ticketId, bookId, run).rewriteFrom(triage.from)
            if (triage.note) this.steers.set(ticketId, { note: triage.note, untilCh: triage.from + 4 })
            this.report(ticketId, { state: 'progress', summary: `已回滚到第${triage.from}章之前，移走 ${moved} 章，从第${triage.from}章重写。` })
          } catch (error) {
            this.report(ticketId, { state: 'blocked', summary: `无法重写：${describe(error)}`, question: `${describe(error)}。要从更晚的一章开始重写吗？默认：不重写，继续往下写。` })
            return 'stop'
          }
          break
        }
        case 'pause':
          files.writeBook({ ...files.readBook(), phase: 'paused', updatedAt: this.now().toISOString() })
          this.report(ticketId, { state: 'waiting', summary: `《${book.title}》已暂停在第${book.lastChapter}章。发“继续”接着写。` })
          return 'stop'
        case 'resume':
          break
        case 'unclear':
          this.report(ticketId, { state: 'blocked', summary: '没看懂这条指令，已暂停。', question: triage.question })
          return 'stop'
      }
    }
    return 'run'
  }

  private async triage(ticketId: string, bookId: string, run: Run, text: string, title: string, lastChapter: number): Promise<Triage> {
    const plain = text.replace(/^小说[:：\s]*/, '').trim()
    if (/^(暂停|停一下|先停)/.test(plain)) return { kind: 'pause' }
    if (/^(继续|接着写|resume)\s*$/i.test(plain)) return { kind: 'resume' }
    const rewrite = /^从第\s*(\d+)\s*章(?:开始)?重写[，,。:：\s]*(.*)$/s.exec(plain)
    if (rewrite?.[1]) return { kind: 'rewrite', from: Number(rewrite[1]), note: (rewrite[2] ?? '').slice(0, 500) }
    const question = this.options.tickets.get(ticketId)?.attention?.question
    const result = await this.asker(ticketId, bookId, run)('planner', TRIAGE_SYSTEM, triageUser({ title, lastChapter, ...(question ? { question } : {}), text: plain }), 600)
    const parsed = TriageSchema.safeParse(extractJson(result.text))
    return parsed.success ? parsed.data : { kind: 'steer', note: plain.slice(0, 500), chapters: 5 }
  }

  // --- Model calls ----------------------------------------------------------------------------------------------------

  private asker(ticketId: string, bookId: string, run: Run): Ask {
    return async (role, system, user, maxTokens, context) => {
      const retryMs = this.options.retryMs ?? 10_000
      let last = ''
      // Rate limits come in bursts on shared gateways: up to 8 tries, backing off up to 2 minutes between them, before
      // the ticket reports failed (a retry from the console continues from the same step).
      for (let attempt = 0; attempt < 8; attempt++) {
        if (run.stopped || this.closed) throw new Stopped()
        const budget = this.options.budget(ticketId)
        if (!budget.ok) {
          throw new NeedsPerson(`${budget.why}。要提高上限后继续吗？默认：在后台「设置 → 小说」调高上限后点“重试”。`, `已达到预算上限：${budget.why}`)
        }
        const resolved = this.options.resolve(role, bookId)
        if (!resolved) throw new NeedsPerson('写小说用的模型不存在或所在服务商未启用。要改用默认执行模型吗？默认：在「设置 → 小说」里选一个可用模型后点“重试”。', '没有可用的写作模型')
        // Reasoning models (DeepSeek Flash) spend reasoning tokens out of `max_tokens`; without headroom a JSON reply or a
        // chapter is cut off, or comes back empty with `finish_reason: length`.
        const budgeted = maxTokens + REASONING_HEADROOM
        const result = await this.call(resolved.target, { model: resolved.model, system, user, maxTokens: budgeted, ...(context ? { context } : {}) }, {
          timeoutMs: this.options.timeoutMs ?? 900_000,
          // One session per role: the roles have different system prompts, so sharing one session made each call
          // displace the previous role's cached prefix.
          sessionId: `novel-${bookId}-${role}`,
          stream: true,
          ...(this.options.fetch ? { fetch: this.options.fetch } : {}),
        })
        try { this.options.step?.(ticketId, `${role}：${result.ok ? '模型返回' : `调用失败（${result.status ?? '网络错误'}）`}，用时 ${Math.round(result.latencyMs / 1000)} 秒`, result.ok ? 'done' : 'error') } catch { /* best effort */ }
        let cost = 0
        try {
          cost = this.options.record({
            ticketId, provider: resolved.provider, model: resolved.model, status: result.status ?? 0,
            ...(result.usage ? { usage: result.usage } : {}), latencyMs: result.latencyMs,
          })
        } catch (error) { this.options.onError?.(error) }
        // A stop that arrived while the call was in flight discards its result.
        if (run.stopped || this.closed) throw new Stopped()
        if (result.ok && result.text.trim()) return { text: result.text, truncated: result.truncated === true, costUsd: cost }
        const status = result.status
        last = `${status ?? '网络错误'}${result.error ? `：${result.error.slice(0, 200)}` : ''}`
        const transient = status === undefined || status === 408 || status === 429 || status >= 500 || result.ok
        if (!transient || attempt === 7) break
        await this.sleep(Math.min(retryMs * 2 ** attempt, 120_000))
      }
      throw new ModelFailure(`模型调用失败（${last}），已重试。点“重试”会从当前这一步接着写。`)
    }
  }
}
