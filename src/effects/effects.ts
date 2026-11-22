/**
 * Durable side-effect queue.
 *
 * A command enqueues an effect in its own transaction; the row lands in the
 * caller's `DatabaseSync` and only runs after the transaction commits. Each
 * (kind, key) pair is one row. Handlers are registered per kind and dispatched
 * after commit, with a per-kind concurrency limit, exponential backoff, and
 * restart-safe storage.
 */
import type { DatabaseSync, StatementSync } from 'node:sqlite'

/** How long a `Later` defers a row when it carries no delay of its own. */
export const LATER_DELAY = 5000
/** Consecutive failures at which `failures` reports a row. */
export const FAILURES_BEFORE_ERROR = 3
/** Default initial and maximum retry delays, in milliseconds (2 s doubling to 60 s). */
export const DEFAULT_RETRY: readonly [number, number] = [2000, 60_000]
/** Default polling interval, in milliseconds. */
export const DEFAULT_POLL_MS = 500

/**
 * Signals that an effect cannot run right now, for example because no worker
 * slot is free. The row is deferred without counting a failure.
 */
export class Later extends Error {
  /** Delay before the row is due again, in milliseconds. */
  readonly delay: number

  /**
   * @param delayOrMessage A delay in milliseconds, or a message (which uses the
   *   default {@link LATER_DELAY}). Omitted: the default delay.
   */
  constructor(delayOrMessage: number | string = LATER_DELAY) {
    super(typeof delayOrMessage === 'string' ? delayOrMessage : 'Later')
    this.name = 'Later'
    this.delay = typeof delayOrMessage === 'number' && Number.isFinite(delayOrMessage) && delayOrMessage >= 0
      ? delayOrMessage
      : LATER_DELAY
  }
}

/** Context handed to a handler alongside the payload. */
export interface EffectContext {
  /** The effect kind. */
  readonly kind: string
  /** The effect key: the same key coalesces into one row. */
  readonly key: string
  /** Consecutive failures before this attempt; 0 for the first attempt. */
  readonly attempts: number
}

/** Options for {@link Effects.handle}. */
export interface HandleOptions {
  /**
   * How many rows of this kind may run at once, or a function returning that
   * number (consulted on every dispatch). 0 pauses the kind. Default 1.
   */
  limit?: number | (() => number)
  /** Initial and maximum retry delays, in milliseconds. Default {@link DEFAULT_RETRY}. */
  retry?: readonly [number, number]
  /**
   * Maximum number of failed attempts before the row stops retrying. It then stays in
   * the table with its last error, and {@link Effects.failures} reports it. Unset:
   * retry without limit.
   */
  maxAttempts?: number
}

/** Options for the {@link Effects} constructor. */
export interface EffectsOptions {
  /** Time source in milliseconds since the epoch. Default `Date.now`. */
  now?: () => number
  /** Polling interval in milliseconds. Default {@link DEFAULT_POLL_MS}. */
  pollMs?: number
  /** Receives errors raised by the queue itself (not by a handler, which retries). */
  onError?: (error: unknown) => void
}

/** A row that failed at least {@link FAILURES_BEFORE_ERROR} times in a row. */
export interface EffectFailure {
  readonly kind: string
  readonly key: string
  /** Consecutive failures so far. */
  readonly attempts: number
  /** The last error, stringified. */
  readonly error: string
  /** When the row is next due, in milliseconds since the epoch. */
  readonly due: number
}

interface Handler {
  run: (payload: unknown, context: EffectContext) => Promise<void> | void
  limit: number | (() => number)
  retry: readonly [number, number]
  maxAttempts: number | undefined
}

/** `seq` keeps the row's queue position; `generation` changes when the payload is replaced. */
interface Row {
  seq: number
  item_key: string
  payload: string
  generation: number
  attempts: number
  due: number
}

interface Task {
  kind: string
  key: string
  done: Promise<void>
}

/** A due time no clock reaches, so a row that exhausted its attempts stays visible but never runs again. */
const NEVER_DUE = Number.MAX_SAFE_INTEGER

const createTable = `
CREATE TABLE IF NOT EXISTS effects (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  item_key TEXT NOT NULL,
  payload TEXT NOT NULL,
  generation INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  error TEXT NOT NULL DEFAULT '',
  due INTEGER NOT NULL,
  UNIQUE (kind, item_key)
)`

const dueIndex = 'CREATE INDEX IF NOT EXISTS effects_due ON effects (kind, due, seq)'

const resolveLimit = (limit: number | (() => number)): number => {
  const value = typeof limit === 'function' ? limit() : limit
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0
}

/**
 * Durable SQLite-backed queue for external side effects (starting workers,
 * delivering messages, sending replies, and so on).
 *
 * The caller owns transactions: `enqueue` is a plain INSERT/UPSERT and may be
 * called inside one, so the row commits or rolls back with the command.
 */
export class Effects {
  private readonly handlers = new Map<string, Handler>()
  private readonly tasks = new Set<Task>()
  private readonly now: () => number
  private readonly pollMs: number
  private readonly onError: (error: unknown) => void
  private scheduled = false
  /** Rows run only between `start` and `drain`. */
  private started = false
  private stopped = false
  private timer: NodeJS.Timeout | undefined

  private readonly insert: StatementSync
  private readonly dueRows: StatementSync
  private readonly deleteOwn: StatementSync
  private readonly failOwn: StatementSync
  private readonly deferOwn: StatementSync
  private readonly pendingAny: StatementSync
  private readonly pendingKind: StatementSync
  private readonly pendingKey: StatementSync
  private readonly failuresOfKind: StatementSync
  private readonly failuresOfAll: StatementSync

  constructor(db: DatabaseSync, options: EffectsOptions = {}) {
    this.now = options.now ?? (() => Date.now())
    this.pollMs = Math.max(1, Math.floor(options.pollMs ?? DEFAULT_POLL_MS))
    this.onError = options.onError ?? (() => {})

    db.exec(createTable)
    db.exec(dueIndex)

    this.insert = db.prepare(`
      INSERT INTO effects (kind, item_key, payload, generation, attempts, error, due)
      VALUES (?, ?, ?, 0, 0, '', ?)
      ON CONFLICT(kind, item_key) DO UPDATE SET
        payload = excluded.payload,
        generation = generation + 1,
        attempts = 0,
        error = '',
        due = excluded.due
    `)
    this.dueRows = db.prepare(
      'SELECT seq, item_key, payload, generation, attempts, due FROM effects WHERE kind = ? AND due <= ? ORDER BY seq LIMIT ?',
    )
    this.deleteOwn = db.prepare(
      'DELETE FROM effects WHERE kind = ? AND item_key = ? AND seq = ? AND generation = ?',
    )
    this.failOwn = db.prepare(
      'UPDATE effects SET attempts = attempts + 1, error = ?, due = ? WHERE kind = ? AND item_key = ? AND seq = ? AND generation = ?',
    )
    this.deferOwn = db.prepare(
      'UPDATE effects SET due = ? WHERE kind = ? AND item_key = ? AND seq = ? AND generation = ?',
    )
    this.pendingAny = db.prepare('SELECT 1 AS present FROM effects LIMIT 1')
    this.pendingKind = db.prepare('SELECT 1 AS present FROM effects WHERE kind = ? LIMIT 1')
    this.pendingKey = db.prepare('SELECT 1 AS present FROM effects WHERE kind = ? AND item_key = ? LIMIT 1')
    this.failuresOfKind = db.prepare(
      'SELECT kind, item_key, attempts, error, due FROM effects WHERE kind = ? AND attempts >= ? ORDER BY seq',
    )
    this.failuresOfAll = db.prepare(
      'SELECT kind, item_key, attempts, error, due FROM effects WHERE attempts >= ? ORDER BY seq',
    )
  }

  /**
   * Upserts an effect in the caller's transaction. A waiting row of the same
   * kind and key keeps its place in the queue but takes the new payload and
   * becomes due immediately; its failure count restarts.
   */
  enqueue<T>(kind: string, key: string, payload: T): void {
    const value = JSON.stringify(payload)
    if (value === undefined) throw new TypeError('An effect payload must be JSON serializable')
    this.insert.run(kind, key, value, this.now())
    this.kick()
  }

  /** Registers the one handler for a kind. */
  handle<T = unknown>(
    kind: string,
    run: (payload: T, context: EffectContext) => Promise<void> | void,
    options: HandleOptions = {},
  ): void {
    if (this.handlers.has(kind)) throw new Error(`Effects of kind "${kind}" already have a handler`)
    const maxAttempts = options.maxAttempts !== undefined && Number.isFinite(options.maxAttempts)
      ? Math.max(1, Math.floor(options.maxAttempts))
      : undefined
    this.handlers.set(kind, {
      run: run as unknown as Handler['run'],
      limit: options.limit ?? 1,
      retry: options.retry ?? DEFAULT_RETRY,
      maxAttempts,
    })
    this.kick()
  }

  /**
   * Whether a row is waiting: for any kind, for a kind, or for one kind and key.
   * Rows that are running are still in SQLite and therefore count as pending.
   */
  pending(kind?: string, key?: string): boolean {
    if (kind === undefined) return this.pendingAny.get() !== undefined
    if (key === undefined) return this.pendingKind.get(kind) !== undefined
    return this.pendingKey.get(kind, key) !== undefined
  }

  /** Rows of a kind (or of every kind) that failed {@link FAILURES_BEFORE_ERROR} times in a row. */
  failures(kind?: string): EffectFailure[] {
    const rows = kind === undefined
      ? this.failuresOfAll.all(FAILURES_BEFORE_ERROR)
      : this.failuresOfKind.all(kind, FAILURES_BEFORE_ERROR)
    return rows.map((row) => ({
      kind: String(row.kind),
      key: String(row.item_key),
      attempts: Number(row.attempts),
      error: String(row.error ?? ''),
      due: Number(row.due),
    }))
  }

  /** Starts polling and dispatches immediately. */
  start(): void {
    this.started = true
    this.stopped = false
    if (!this.timer) {
      this.timer = setInterval(() => this.dispatch(), this.pollMs)
      this.timer.unref()
    }
    this.kick()
  }

  /** Schedules one dispatch on the microtask queue, coalescing repeated kicks. */
  kick(): void {
    if (this.scheduled) return
    this.scheduled = true
    queueMicrotask(() => {
      this.scheduled = false
      this.dispatch()
    })
  }

  /**
   * Resolves once nothing of `kind` (or of any kind) is running and nothing
   * else can start now: no row is due, or `limit` leaves no room.
   */
  async idle(kind?: string): Promise<void> {
    for (;;) {
      this.dispatch()
      const running = [...this.tasks]
        .filter((task) => kind === undefined || task.kind === kind)
        .map((task) => task.done)
      if (running.length === 0) return
      await Promise.allSettled(running)
    }
  }

  /**
   * Stops starting new rows and waits for running ones. Waiting rows stay in
   * SQLite, and a row cut short by shutdown is left untouched so it retries
   * after the next start.
   */
  async drain(): Promise<void> {
    this.stopped = true
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = undefined
    }
    await Promise.allSettled([...this.tasks].map((task) => task.done))
  }

  private dispatch(): void {
    if (!this.started || this.stopped) return
    const now = this.now()
    for (const [kind, handler] of this.handlers) {
      try {
        const running = new Set<string>()
        for (const task of this.tasks) if (task.kind === kind) running.add(task.key)
        // Fetch more than the running rows so a busy head does not starve later rows.
        const rows = this.dueRows.all(kind, now, 64 + running.size) as unknown as Row[]
        if (rows.length === 0) continue
        let room = resolveLimit(handler.limit) - running.size
        for (const row of rows) {
          if (room <= 0) break
          if (running.has(row.item_key)) continue
          running.add(row.item_key)
          room -= 1
          this.run(kind, handler, row)
        }
      } catch (error) {
        this.onError(error)
      }
    }
  }

  private run(kind: string, handler: Handler, row: Row): void {
    const task: Task = { kind, key: row.item_key, done: Promise.resolve() }
    task.done = this.attempt(kind, handler, row)
      .catch((error: unknown) => { this.onError(error) })
      .finally(() => {
        this.tasks.delete(task)
        this.kick()
      })
    this.tasks.add(task)
  }

  private async attempt(kind: string, handler: Handler, row: Row): Promise<void> {
    let failure: unknown
    let failed = false
    try {
      const payload = JSON.parse(row.payload) as unknown
      await handler.run(payload, { kind, key: row.item_key, attempts: row.attempts })
    } catch (error) {
      failed = true
      failure = error
    }

    // Seq and generation identify the version that ran: a row replaced or
    // re-queued while running must not be deleted or overwritten by this attempt.
    const own = 'kind = ? AND item_key = ? AND seq = ? AND generation = ?'
    const ownRow = [kind, row.item_key, row.seq, row.generation] as const

    if (!failed) {
      this.deleteOwn.run(...ownRow)
      return
    }
    // Shutdown leaves the row untouched so it tries again after the next start.
    if (this.stopped) return

    if (failure instanceof Later) {
      this.deferOwn.run(this.now() + failure.delay, ...ownRow)
      return
    }

    const [initial, maximum] = handler.retry
    const delay = Math.min(maximum, initial * 2 ** Math.min(row.attempts, 16))
    // This attempt is the row's `row.attempts + 1`th consecutive failure. At the cap the row keeps its last error but
    // is parked at a due time no clock reaches, so it stays visible to `failures` and never runs again.
    const exhausted = handler.maxAttempts !== undefined && row.attempts + 1 >= handler.maxAttempts
    const due = exhausted ? NEVER_DUE : this.now() + delay
    this.failOwn.run(String(failure).slice(0, 1000), due, ...ownRow)
  }
}
