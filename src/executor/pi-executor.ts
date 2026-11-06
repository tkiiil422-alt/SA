/**
 * Pi-backed implementation of the domain `Executor` port.
 *
 * The Engine calls `start`, `deliver` and `stop` inside its own transactions, so those methods only queue durable effects.
 * After the transaction commits, the effect queue runs a `launch` or `delivery` handler, which starts the configured Pi
 * process (the launcher decides the command), prompts it, steers or follows up while it runs, and reports the outcome back
 * through the Engine's executor-side callbacks. Every callback runs inside an `atomic` transaction supplied by the host.
 *
 * Concurrency follows the prototype's worker-slot rules: a ticket holds one of `maxSlots` from its launch until the turn
 * ends (or it stops), and a delivery that wakes an idle worker may use one extra slot reserved for a person's follow-up.
 */
import { latestReport, threadKey } from '../core/model.ts'
import type { Assignment, Ticket, TicketInput } from '../core/model.ts'
import type { EngineForExecutor } from '../core/engine.ts'
import type { Executor, Repositories } from '../core/ports.ts'
import { Later, type Effects } from '../effects/effects.ts'
import { PiRpcClient } from './pi-rpc.ts'
import type { PiEvent, PiProcessExit } from './pi-rpc.ts'
import type { ActivityLog } from './activity.ts'

/** How to launch one Pi RPC process; the launcher owns the command and environment. */
export interface PiLaunch {
  command: string
  args: string[]
  cwd?: string
  env?: Record<string, string>
}

/**
 * How one launch relates to the ticket's previous Session. `resume` is true when Pi should continue the Session it wrote for
 * this ticket earlier (such as a wake after an idle retirement), so the launcher appends `--continue`; a first launch does not.
 */
export interface PiLaunchContext { resume: boolean }

/**
 * Decides the process for a ticket's assignment, such as `pi --mode rpc` or the same command under a container runtime. A
 * launcher that ignores how the launch relates to the previous Session may still take only the first two parameters.
 */
export type PiLauncher = (ticket: Ticket, assignment: Assignment, context: PiLaunchContext) => PiLaunch | Promise<PiLaunch>

/** Host dependencies of {@link PiExecutor}. */
export interface PiExecutorOptions {
  /** Durable side-effect queue through which launches and deliveries run. */
  effects: Effects
  /** Getter for the Engine's executor-side callbacks; a getter avoids constructing Engine and Executor circularly. */
  engine: () => EngineForExecutor
  launcher: PiLauncher
  /** Prepares a ticket's workspace before its process starts; optional. */
  prepare?: (ticket: Ticket) => Promise<void>
  /** Maximum number of concurrent worker slots, plus one extra for waking an idle worker with a person's follow-up. */
  maxSlots: number
  /** Grace period passed to `PiRpcClient.close`. Default 2s. */
  graceMs?: number
  /**
   * How long one turn may stay streaming without `agent_settled` before the process is stopped and the ticket is
   * reported failed. Default 30 minutes; 0 disables the watchdog.
   */
  turnTimeoutMs?: number
  /** Runs a unit of Engine callback work in the host's transaction. */
  atomic: <T>(work: () => T) => T
  /** Runs `fn` once the caller's transaction commits, or immediately when none is open. */
  afterCommit: (fn: () => void) => void
  /** The ticket repository, read by `resume` and by the effect handlers to re-check the stored ticket. */
  tickets: Pick<Repositories['tickets'], 'get' | 'open' | 'list'>
  /** The trigger repository, read to put a ticket's original request and inputs into Pi's messages. */
  triggers?: Pick<Repositories['triggers'], 'get'>
  /** In-memory record of each worker's recent steps, shown on the task detail page. */
  activity?: Pick<ActivityLog, 'record' | 'note'>
}

interface LaunchPayload { ticketId: string; assignmentId: string }
interface DeliveryPayload { ticketId: string; assignmentId: string }

/** One live Pi process and the bookkeeping around it. */
interface ClientEntry {
  ticketId: string
  assignmentId: string
  client: PiRpcClient
  /** Whether Pi is in a run that a new Input can steer or follow up; false when it is idle. */
  streaming: boolean
  /** Set when the Executor deliberately ends this client, so its exit is not a crash. */
  stopped: boolean
  /** Input ids delivered since the last `agent_settled`, reported read when that turn ends. */
  pendingRead: string[]
  /** Watchdog for a turn that stays streaming too long; cleared whenever the turn ends or the entry stops. */
  timer?: NodeJS.Timeout
}

/** Delay before a launch or delivery blocked on a full slot is tried again. */
const SLOT_RETRY_MS = 50
/** Delay before aborting a process whose ticket just ended, so an in-flight MCP tool response can be written. */
const STOP_FLUSH_MS = 250
/** Default watchdog for a turn that never settles. */
const DEFAULT_TURN_TIMEOUT_MS = 30 * 60_000
/** Character limits for the request and input text in a Pi message. */
const REQUEST_CHARS = 2_000
const INPUT_CHARS = 2_000

const cap = (text: string, limit: number): string => text.length <= limit ? text : `${text.slice(0, limit)}…`
const describe = (error: unknown): string => error instanceof Error ? error.message : String(error)

/** Whether an Input comes from a person rather than a bot, CI or the orchestrator. */
const fromPerson = (input: TicketInput | undefined): boolean =>
  input?.kind === 'trigger' ? !!input.human && !input.context : input?.kind === 'text'

/** The Executor the Engine calls; see `Executor` in `src/core/ports.ts`. */
export class PiExecutor implements Executor {
  private maxSlots: number
  private readonly graceMs: number
  private readonly turnTimeoutMs: number
  /** Live clients by ticket id; at most one process per ticket. */
  private readonly clients = new Map<string, ClientEntry>()
  /** Tickets currently holding a worker slot, from launch until their turn ends or they stop. */
  private readonly held = new Set<string>()
  /** Tickets with a slot reserved while a launch or wake is starting. */
  private readonly starting = new Set<string>()
  /** Per-ticket operation chains, so a launch's prompt lands before a delivery's steer. */
  private readonly chains = new Map<string, Promise<void>>()
  /** Per-ticket process shutdown in progress, which a new launch waits for. */
  private readonly closing = new Map<string, Promise<void>>()
  private closed = false

  constructor(private readonly options: PiExecutorOptions) {
    this.maxSlots = Math.max(1, Math.floor(options.maxSlots))
    this.graceMs = options.graceMs ?? 2_000
    this.turnTimeoutMs = Math.max(0, options.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS)
    // A launch admits one worker per slot; deliveries to distinct tickets may run alongside them. A delivery that keeps
    // failing (an input Pi refuses, say) stops after a bounded number of attempts instead of retrying forever.
    options.effects.handle<LaunchPayload>('launch', payload => this.launchQueued(payload), { limit: () => this.maxSlots, retry: [500, 30_000] })
    options.effects.handle<DeliveryPayload>('delivery', payload => this.deliverQueued(payload), {
      limit: () => this.maxSlots + 1,
      retry: [250, 10_000],
      maxAttempts: 6,
    })
  }

  /** Changes the worker limit at run time; running workers are not interrupted, new launches use the new limit. */
  setMaxSlots(value: number): void {
    this.maxSlots = Math.max(1, Math.floor(value))
  }

  /** Slots in use now and the current limit, for the admin overview. */
  slots(): { used: number; max: number } {
    return { used: this.used(), max: this.maxSlots }
  }

  /** Whether a live Pi process (the ticket's container) exists for this ticket right now. */
  isRunning(ticketId: string): boolean {
    const entry = this.clients.get(ticketId)
    return entry !== undefined && entry.client.isRunning
  }

  /** Queues a launch; the `launch` handler reports back through `assignmentStarted` or a `failed` report. */
  start(ticket: Ticket, assignment: Assignment): void {
    this.options.effects.enqueue<LaunchPayload>('launch', ticket.id, { ticketId: ticket.id, assignmentId: assignment.id })
  }

  /** Queues delivery of the ticket's waiting Inputs; the `delivery` handler reports back through `inputsDelivered` or `deliveryFailed`. */
  deliver(ticket: Ticket, assignment: Assignment): void {
    this.options.effects.enqueue<DeliveryPayload>('delivery', ticket.id, { ticketId: ticket.id, assignmentId: assignment.id })
  }

  /** After the ending transaction commits, aborts and closes the ticket's process. */
  stop(ticket: Ticket, assignment: Assignment, _reason: string): void {
    this.options.afterCommit(() => {
      const entry = this.clients.get(ticket.id)
      if (!entry || entry.assignmentId !== assignment.id) return
      // A ticket often ends because the worker itself reported over its MCP connection: aborting in this same tick
      // kills that connection before the tool response is written, and the worker sees a broken call. Give the response
      // a moment to reach it first; the process is stopped either way.
      const timer = setTimeout(() => this.stopEntry(entry), STOP_FLUSH_MS)
      timer.unref()
    })
  }

  /**
   * Reconciles assignments that were running when the host stopped: each is reported to the Engine as interrupted, which
   * decides whether to restart it with a recovery note or to hand it what waits for it. A process still alive in this
   * process for that ticket is stopped first.
   */
  resume(): void {
    if (this.closed) return
    const tickets = [...this.options.tickets.open()].sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    for (const ticket of tickets) {
      const running = ticket.assignments.find(assignment => assignment.state === 'running')
      if (!running) continue
      const entry = this.clients.get(ticket.id)
      if (entry) this.stopEntry(entry)
      try {
        this.options.atomic(() => this.options.engine().assignmentInterrupted(ticket.id, running.id))
      } catch {
        // The ticket moved on between the read and the callback; nothing to reconcile.
      }
    }
  }

  /** Stops every process this Executor owns; used on host shutdown and in tests. Idempotent. */
  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    const entries = [...this.clients.values()]
    this.clients.clear()
    this.held.clear()
    this.starting.clear()
    for (const entry of entries) {
      entry.stopped = true
      this.clearWatchdog(entry)
    }
    await Promise.allSettled(entries.map(async entry => {
      try { await entry.client.close({ graceMs: this.graceMs }) } catch { /* already gone */ }
    }))
  }

  // Effect handlers

  private async launchQueued({ ticketId, assignmentId }: LaunchPayload): Promise<void> {
    if (this.closed) return
    await this.closing.get(ticketId)?.catch(() => undefined)
    return this.serial(ticketId, async () => {
      const ticket = this.options.tickets.get(ticketId)
      const assignment = ticket?.assignments.find(item => item.id === assignmentId)
      if (!ticket || ticket.ended || !assignment || assignment.state === 'ended') return
      // A previous process for this ticket, such as the one an interrupted Assignment left, stops first.
      const existing = this.clients.get(ticketId)
      if (existing) {
        if (existing.assignmentId === assignmentId && existing.client.isRunning) return
        this.stopEntry(existing)
        await this.closing.get(ticketId)?.catch(() => undefined)
      }
      // Throws `Later` when every slot is taken, so the row keeps its place and retries.
      this.reserve(ticketId, 'launch')
      let entry: ClientEntry | undefined
      try {
        await this.options.prepare?.(ticket)
        if (!this.current(ticketId, assignmentId)) { this.release(ticketId); return }
        // A ticket whose earlier Assignment started has a Session in Pi's state directory; a restart or a retry continues it.
        // A first launch has none, so it starts fresh.
        entry = await this.spawn(ticket, assignment, this.hasSession(ticket, assignment))
        this.activate(ticketId)
        if (this.closed || !this.current(ticketId, assignmentId)) { this.stopEntry(entry); return }
        this.call(() => this.options.engine().assignmentStarted(ticketId, assignmentId))
        if (!this.current(ticketId, assignmentId)) { this.stopEntry(entry); return }
        const disposition = await entry.client.prompt(this.assignmentMessage(ticket))
        entry.streaming = disposition !== 'handled'
        if (entry.streaming) this.armWatchdog(entry)
        // `handled` means Pi started no run, so no `agent_settled` will arrive to free the slot.
        else this.release(ticketId)
      } catch (error) {
        this.release(ticketId)
        if (entry) this.stopEntry(entry)
        if (error instanceof Later) throw error
        this.failed(ticketId, assignmentId, `The Pi launch failed: ${describe(error)}`)
      }
    })
  }

  private async deliverQueued({ ticketId, assignmentId }: DeliveryPayload): Promise<void> {
    if (this.closed) return
    await this.closing.get(ticketId)?.catch(() => undefined)
    return this.serial(ticketId, async () => {
      for (;;) {
        if (this.closed) return
        const ticket = this.options.tickets.get(ticketId)
        if (!ticket || ticket.ended) return
        const assignment = ticket.assignments.find(item => item.id === assignmentId && item.state === 'running')
        if (!assignment) return
        const inputId = ticket.undelivered[0]
        if (inputId === undefined) return
        const input = ticket.inputs.find(item => item.id === inputId)
        if (!input) { this.delivered(ticketId, assignmentId, [inputId]); continue }
        const text = this.inputMessage(input)
        // A legacy `reopen` input carries no message of its own; it still counts as delivered.
        if (text === undefined) { this.delivered(ticketId, assignmentId, [inputId]); continue }

        const person = fromPerson(input)
        const entry = this.clients.get(ticketId)?.client.isRunning
          ? this.clients.get(ticketId)!
          : await this.wake(ticket, assignment, person)
        if (!this.running(ticketId, assignmentId)) { this.stopEntry(entry); return }
        try {
          this.reserveForDelivery(ticketId, person)
          if (entry.streaming) {
            if (person) await entry.client.steer(text)
            else await entry.client.followUp(text)
            entry.streaming = true
          } else {
            const disposition = await entry.client.prompt(text)
            entry.streaming = disposition !== 'handled'
          }
          if (entry.streaming) {
            this.activate(ticketId)
            this.armWatchdog(entry)
          } else {
            // Pi handled the input without starting a run; no `agent_settled` will release the slot.
            this.release(ticketId)
          }
        } catch (error) {
          // A full slot is a deferral, not a failed delivery; Effects retries the row without recording an error.
          if (!(error instanceof Later)) {
            this.call(() => this.options.engine().deliveryFailed(ticketId, assignmentId, describe(error).slice(0, 300)))
          }
          throw error
        }
        this.delivered(ticketId, assignmentId, [inputId])
        entry.pendingRead.push(inputId)
      }
    })
  }

  // Process lifecycle

  /** Starts a Pi process for `ticket` and installs its listeners; the caller holds a reserved slot. */
  private async spawn(ticket: Ticket, assignment: Assignment, resume: boolean): Promise<ClientEntry> {
    // The launcher may need to await the host (allocating preview ports probes loopback before the container starts).
    const launch = await this.options.launcher(ticket, assignment, { resume })
    const client = new PiRpcClient({
      command: launch.command,
      args: launch.args,
      ...(launch.cwd !== undefined ? { cwd: launch.cwd } : {}),
      ...(launch.env !== undefined ? { env: launch.env } : {}),
    })
    const entry: ClientEntry = { ticketId: ticket.id, assignmentId: assignment.id, client, streaming: false, stopped: false, pendingRead: [] }
    client.onEvent(event => this.onEvent(entry, event))
    client.onExit(exit => this.onExit(entry, exit))
    await client.start()
    this.clients.set(ticket.id, entry)
    return entry
  }

  /**
   * Starts a process for a running assignment whose client is gone, such as after a crash and a person's follow-up, and
   * gives it the assignment brief again. The caller holds a reserved slot.
   */
  private async wake(ticket: Ticket, assignment: Assignment, person: boolean): Promise<ClientEntry> {
    const stale = this.clients.get(ticket.id)
    if (stale) this.stopEntry(stale)
    await this.closing.get(ticket.id)?.catch(() => undefined)
    this.reserve(ticket.id, person ? 'person' : 'wake')
    let entry: ClientEntry | undefined
    try {
      entry = await this.spawn(ticket, assignment, true)
      this.activate(ticket.id)
      if (this.closed || !this.running(ticket.id, assignment.id)) { this.stopEntry(entry); throw new Later(SLOT_RETRY_MS) }
      const disposition = await entry.client.prompt(this.assignmentMessage(ticket))
      entry.streaming = disposition !== 'handled'
      if (entry.streaming) this.armWatchdog(entry)
      // `handled` means Pi started no run, so no `agent_settled` will arrive to free the slot.
      else this.release(ticket.id)
      return entry
    } catch (error) {
      this.release(ticket.id)
      if (entry) this.stopEntry(entry)
      if (error instanceof Later) throw error
      this.failed(ticket.id, assignment.id, `The Pi wake failed: ${describe(error)}`)
      throw error
    }
  }

  private onEvent(entry: ClientEntry, event: PiEvent): void {
    if (entry.stopped || this.clients.get(entry.ticketId) !== entry) return
    try {
      this.options.activity?.record(entry.ticketId, event)
    } catch { /* the activity log is a view; it must never break the turn */ }
    // The watchdog measures silence, not total length: a long turn that keeps producing steps is still working.
    if (event.type !== 'agent_settled' && entry.streaming && entry.timer !== undefined) {
      this.clearWatchdog(entry)
      this.armWatchdog(entry)
    }
    if (event.type !== 'agent_settled') return
    this.clearWatchdog(entry)
    entry.streaming = false
    const read = entry.pendingRead.splice(0)
    if (read.length) this.call(() => this.options.engine().inputsRead(entry.ticketId, read))
    this.call(() => this.options.engine().turnEnded(entry.ticketId, entry.assignmentId))
    // The turn handed off: the slot is free for another ticket, as in the prototype's WorkerSlots.
    this.release(entry.ticketId)
    // A worker with nothing left to do exits instead of holding its container; a later Input wakes it with `--continue`.
    // Run the check in the ticket's serial chain so it cannot race a delivery that is already reaching the process.
    void this.serial(entry.ticketId, async () => this.retireIdle(entry)).catch(() => undefined)
  }

  private onExit(entry: ClientEntry, exit: PiProcessExit): void {
    if (entry.stopped) return
    this.clearWatchdog(entry)
    if (this.clients.get(entry.ticketId) === entry) this.clients.delete(entry.ticketId)
    this.release(entry.ticketId)
    entry.streaming = false
    const ticket = this.options.tickets.get(entry.ticketId)
    if (!ticket || ticket.ended) return
    const assignment = ticket.assignments.find(item => item.id === entry.assignmentId)
    if (!assignment || assignment.state === 'ended') return
    // A worker that already reported its result is not crashed; only an unexpected exit is a failure.
    if (assignment.report && ['ready', 'dropped', 'failed'].includes(assignment.report.state)) return
    const tail = exit.stderr.slice(-3).join(' | ')
    const summary = `Pi exited unexpectedly (code=${exit.code ?? 'null'}, signal=${exit.signal ?? 'null'})${tail ? `: ${tail}` : ''}`
    this.call(() => this.options.engine().report(entry.ticketId, { state: 'failed', summary }))
  }

  /**
   * Closes the ticket's process once its turn ended and nothing is left for it: the ticket ended, or its latest report waits
   * on a person (`waiting`, `ready`, `blocked`, `failed`, `dropped`) with no undelivered Input. The process already settled,
   * so this only closes it; no abort is needed, and marking it `stopped` keeps its exit from being reported as a crash.
   */
  private async retireIdle(entry: ClientEntry): Promise<void> {
    if (this.closed || entry.stopped || entry.streaming) return
    if (this.clients.get(entry.ticketId) !== entry) return
    const ticket = this.options.tickets.get(entry.ticketId)
    if (!ticket) return
    if (!ticket.ended) {
      const report = latestReport(ticket)
      if (!report || !['waiting', 'ready', 'blocked', 'failed', 'dropped'].includes(report.state)) return
      // An Input still waiting is the next turn's work; the delivery handler wakes the process for it.
      if (ticket.undelivered.length > 0) return
    }
    this.retireEntry(entry)
  }

  /** Whether a launch continues a Session this ticket already had: an Assignment of it started before. */
  private hasSession(ticket: Ticket, assignment: Assignment): boolean {
    return assignment.startedAt !== undefined
      || ticket.assignments.some(item => item.id !== assignment.id && item.startedAt !== undefined)
  }

  private retireEntry(entry: ClientEntry): void {
    if (entry.stopped) return
    this.clearWatchdog(entry)
    entry.stopped = true
    if (this.clients.get(entry.ticketId) === entry) this.clients.delete(entry.ticketId)
    this.release(entry.ticketId)
    const closing = (async () => {
      try { await entry.client.close({ graceMs: this.graceMs }) } catch { /* already gone */ }
    })()
    this.closing.set(entry.ticketId, closing)
    void closing.finally(() => {
      if (this.closing.get(entry.ticketId) === closing) this.closing.delete(entry.ticketId)
    })
  }

  private stopEntry(entry: ClientEntry): void {
    if (entry.stopped) return
    this.clearWatchdog(entry)
    entry.stopped = true
    if (this.clients.get(entry.ticketId) === entry) this.clients.delete(entry.ticketId)
    this.release(entry.ticketId)
    const closing = (async () => {
      try { await entry.client.abort() } catch { /* the process already exited */ }
      try { await entry.client.close({ graceMs: this.graceMs }) } catch { /* already gone */ }
    })()
    this.closing.set(entry.ticketId, closing)
    void closing.finally(() => {
      if (this.closing.get(entry.ticketId) === closing) this.closing.delete(entry.ticketId)
    })
  }

  // Slots

  private used(): number {
    return new Set([...this.held, ...this.starting]).size
  }

  /** Reserves a slot for `ticketId`, allowing the one extra slot only for a person's follow-up wake. */
  private reserve(ticketId: string, by: 'launch' | 'wake' | 'person'): void {
    if (this.held.has(ticketId) || this.starting.has(ticketId)) return
    if (this.used() >= this.maxSlots + (by === 'person' ? 1 : 0)) throw new Later(SLOT_RETRY_MS)
    this.starting.add(ticketId)
  }

  /** Reserves a slot for a delivery that will start a turn on an idle worker. */
  private reserveForDelivery(ticketId: string, person: boolean): void {
    if (this.held.has(ticketId) || this.starting.has(ticketId)) return
    this.reserve(ticketId, person ? 'person' : 'wake')
  }

  private activate(ticketId: string): void {
    this.starting.delete(ticketId)
    this.held.add(ticketId)
  }

  private release(ticketId: string): void {
    this.starting.delete(ticketId)
    this.held.delete(ticketId)
  }

  // Watchdog

  /**
   * Arm the turn watchdog when an entry starts streaming. Every Pi event re-arms it (see `onEvent`), so it fires only after
   * `turnTimeoutMs` of complete silence without `agent_settled`.
   */
  private armWatchdog(entry: ClientEntry): void {
    if (this.turnTimeoutMs <= 0 || entry.timer !== undefined) return
    const timer = setTimeout(() => {
      entry.timer = undefined
      if (entry.stopped || this.clients.get(entry.ticketId) !== entry || !entry.streaming) return
      this.stopEntry(entry)
      const minutes = Math.max(1, Math.round(this.turnTimeoutMs / 60_000))
      try {
        this.options.atomic(() => this.options.engine().report(entry.ticketId, {
          state: 'failed',
          summary: `执行超时，已被强制停止（超过 ${minutes} 分钟没有任何动静）。在任务里发一条新指令就能接着干。`,
        }))
      } catch (error) {
        console.error(`superagent: timed-out turn report failed: ${describe(error)}`)
      }
    }, this.turnTimeoutMs)
    // A pending turn must never keep the host process alive.
    timer.unref()
    entry.timer = timer
  }

  private clearWatchdog(entry: ClientEntry): void {
    if (entry.timer === undefined) return
    clearTimeout(entry.timer)
    entry.timer = undefined
  }

  // Engine callbacks

  /** Runs an Engine callback in the host transaction; a callback about state that moved on is ignored. */
  private call(work: () => void): void {
    try {
      this.options.atomic(work)
    } catch {
      // Unknown or ended ticket/assignment: the fact no longer applies.
    }
  }

  private delivered(ticketId: string, assignmentId: string, inputIds: string[]): void {
    this.call(() => this.options.engine().inputsDelivered(ticketId, assignmentId, inputIds))
  }

  private failed(ticketId: string, assignmentId: string, summary: string): void {
    const ticket = this.options.tickets.get(ticketId)
    if (!ticket || ticket.ended) return
    const assignment = ticket.assignments.find(item => item.id === assignmentId)
    if (!assignment || assignment.state === 'ended') return
    this.call(() => this.options.engine().report(ticketId, { state: 'failed', summary: summary.slice(0, 2_000) }))
  }

  // Reads

  private current(ticketId: string, assignmentId: string): boolean {
    const ticket = this.options.tickets.get(ticketId)
    if (!ticket || ticket.ended) return false
    const assignment = ticket.assignments.find(item => item.id === assignmentId)
    return !!assignment && assignment.state !== 'ended'
  }

  private running(ticketId: string, assignmentId: string): boolean {
    const ticket = this.options.tickets.get(ticketId)
    return !!ticket && !ticket.ended && ticket.assignments.some(item => item.id === assignmentId && item.state === 'running')
  }

  /** Runs `work` after earlier work for the same ticket, so a launch's prompt precedes a delivery's steer. */
  private serial<T>(ticketId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.chains.get(ticketId) ?? Promise.resolve()
    const run = previous.then(work, work)
    const tail = run.then(() => undefined, () => undefined)
    this.chains.set(ticketId, tail)
    void tail.finally(() => {
      if (this.chains.get(ticketId) === tail) this.chains.delete(ticketId)
    })
    return run
  }

  // Messages

  private assignmentMessage(ticket: Ticket): string {
    const trigger = this.options.triggers?.get(ticket.origin.triggerId)
    const request = trigger?.text ?? ticket.execution?.assignment ?? ticket.title
    return JSON.stringify({
      ticket_id: ticket.id,
      // The worker needs the real trigger id for `sa_ack`/`sa_handback`; it is a hash that a thread cannot derive.
      trigger_id: ticket.origin.triggerId,
      title: ticket.title,
      scope: ticket.mandate.scope,
      request: cap(request, REQUEST_CHARS),
      ...(trigger ? { from: trigger.actor.id, thread: threadKey(trigger.threads[0]!) } : {}),
      ...(ticket.execution?.assignment && ticket.execution.assignment !== request
        ? { assignment: cap(ticket.execution.assignment, REQUEST_CHARS) } : {}),
    })
  }

  private inputMessage(input: TicketInput): string | undefined {
    switch (input.kind) {
      case 'trigger': {
        const trigger = this.options.triggers?.get(input.triggerId)
        return JSON.stringify({
          kind: 'trigger',
          trigger_id: input.triggerId,
          ...(trigger ? { from: trigger.actor.id, at: trigger.at, text: cap(trigger.text, INPUT_CHARS) } : {}),
          ...(input.note ? { note: input.note } : {}),
          ...(input.context ? { context: true } : {}),
        })
      }
      case 'text': return input.text
      case 'note': return `Note from the orchestrator, for context only: ${input.text}`
      case 'policy-changed': return 'Policy change: the access or admission rules changed. Check that the remaining work stays within the assignment.'
      case 'resumed': return 'This ticket ended earlier and the message that follows resumed it under the same mandate. Continue within the original scope and report ready when the follow-up is done.'
      case 'reopen': return undefined
    }
  }
}
