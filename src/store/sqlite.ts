/**
 * SQLite-backed implementation of the domain `Repositories` port.
 *
 * Aggregates are stored whole as JSON text (one row per entity) with generated columns indexing the few predicates the
 * Engine queries by. Every method is synchronous, matching the port and the Engine's transactional `atomic` usage.
 */
import { DatabaseSync, type SQLInputValue, type SQLOutputValue } from 'node:sqlite'
import type { Decision, Thread, Ticket, Trigger, TriggerDisposition } from '../core/model.ts'
import type { Repositories } from '../core/ports.ts'

/** Current schema version, recorded in SQLite's `user_version` header field. */
export const SCHEMA_VERSION = 1
/** Business-error codes tests and callers can rely on. */
export const STORE_ERRORS = {
  newerSchema: 'The database schema is newer than this build supports',
  missingMigration: 'No migration is registered for the next schema version',
} as const

/**
 * Schema migrations, keyed by the version they produce. Applied in ascending order inside one transaction each.
 * Version 1 creates the entity tables and the indexes the read queries use.
 */
const MIGRATIONS: Record<number, (db: DatabaseSync) => void> = {
  1: db => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS triggers (
        id TEXT PRIMARY KEY,
        source TEXT NOT NULL,
        at TEXT NOT NULL,
        value TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS triggers_source_at ON triggers(source, at);

      CREATE TABLE IF NOT EXISTS dispositions (
        id TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS threads (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        active INTEGER GENERATED ALWAYS AS (
          CASE WHEN json_array_length(value, '$.pending') > 0 OR value -> '$.evaluating' IS NOT NULL THEN 1 ELSE 0 END
        ) VIRTUAL
      );
      CREATE INDEX IF NOT EXISTS threads_active ON threads(active) WHERE active = 1;

      CREATE TABLE IF NOT EXISTS tickets (
        id TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        open INTEGER GENERATED ALWAYS AS (
          CASE WHEN value -> '$.ended' IS NULL THEN 1 ELSE 0 END
        ) VIRTUAL,
        active INTEGER GENERATED ALWAYS AS (
          CASE WHEN json_array_length(value, '$.undelivered') > 0
            OR value ->> '$.assignments[#-1].state' IN ('pending', 'running') THEN 1 ELSE 0 END
        ) VIRTUAL
      );
      CREATE INDEX IF NOT EXISTS tickets_open ON tickets(open) WHERE open = 1;
      CREATE INDEX IF NOT EXISTS tickets_active ON tickets(active) WHERE active = 1;

      CREATE TABLE IF NOT EXISTS decisions (
        id TEXT PRIMARY KEY,
        thread_key TEXT NOT NULL,
        value TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS decisions_thread_key ON decisions(thread_key);
    `)
  },
}

/**
 * Durable repositories on a `node:sqlite` connection.
 *
 * Construct with a file path (or `':memory:'`) or with an already-open `DatabaseSync`; `db` stays public so later
 * components, such as an effect queue, can create their own tables on the same connection and transaction.
 *
 * Ordering matches `MemoryRepositories`: threads and a thread's decisions come in insertion order, tickets newest first.
 */
export class SqliteRepositories implements Repositories {
  /** The underlying connection, shared with components that add their own tables. */
  readonly db: DatabaseSync
  /** Nesting depth of `atomic`, used to decide between `BEGIN` and `SAVEPOINT`. */
  private depth = 0
  /** Monotonic suffix keeping savepoint names unique even across re-entered nesting. */
  private savepoints = 0
  /** Pending `afterCommit` callbacks, one frame per open transaction/savepoint level; rolled-back frames are dropped. */
  private readonly frames: (() => void)[][] = []

  constructor(source: string | DatabaseSync) {
    this.db = typeof source === 'string' ? new DatabaseSync(source, { timeout: 5_000 }) : source
    // WAL only matters for file databases; in-memory connections report no location.
    if (this.db.location() !== null) this.db.exec('PRAGMA journal_mode=WAL')
    this.db.exec('PRAGMA foreign_keys=ON')
    this.db.exec('PRAGMA busy_timeout=5000')
    this.migrate()
  }

  /** Applies every registered migration between the stored `user_version` and `SCHEMA_VERSION`. */
  private migrate(): void {
    const stored = Number(this.db.prepare('PRAGMA user_version').get()?.user_version ?? 0)
    if (stored > SCHEMA_VERSION) {
      throw new Error(`${STORE_ERRORS.newerSchema}: database has version ${stored}, this build supports ${SCHEMA_VERSION}`)
    }
    for (let next = stored + 1; next <= SCHEMA_VERSION; next += 1) {
      const migration = MIGRATIONS[next]
      if (!migration) throw new Error(`${STORE_ERRORS.missingMigration}: ${next}`)
      this.atomic(() => {
        migration(this.db)
        // `next` is a loop-counter integer, never user input, so interpolation is safe (PRAGMA does not bind parameters).
        this.db.exec(`PRAGMA user_version = ${next}`)
      })
    }
  }

  /**
   * Runs `work` in a transaction. The outermost call uses `BEGIN IMMEDIATE`/`COMMIT`; nested calls use savepoints, so an
   * inner failure rolls back only the inner work when the caller catches it. On failure the transaction rolls back and the
   * error is rethrown. `afterCommit` callbacks queued by the rolled-back work are discarded.
   */
  atomic<T>(work: () => T): T {
    if (this.depth === 0) {
      this.db.exec('BEGIN IMMEDIATE')
      this.depth = 1
      this.frames.push([])
      let value: T
      try {
        value = work()
      } catch (error) {
        try { this.db.exec('ROLLBACK') } catch { /* keep the work's error */ } finally { this.frames.pop(); this.depth = 0 }
        throw error
      }
      try {
        this.db.exec('COMMIT')
      } catch (error) {
        try { this.db.exec('ROLLBACK') } catch { /* the transaction may already be gone */ }
        this.frames.pop()
        this.depth = 0
        throw error
      }
      const actions = this.frames.pop()!
      this.depth = 0
      this.runAfterCommit(actions)
      return value
    }
    const level = this.depth
    const name = `superagent_atomic_${level}_${this.savepoints++}`
    this.depth = level + 1
    this.frames.push([])
    this.db.exec(`SAVEPOINT ${name}`)
    let value: T
    try {
      value = work()
      this.db.exec(`RELEASE ${name}`)
    } catch (error) {
      try {
        this.db.exec(`ROLLBACK TO ${name}`)
        this.db.exec(`RELEASE ${name}`)
      } catch { /* keep the work's error */ } finally {
        this.frames.pop()
        this.depth = level
      }
      throw error
    }
    const actions = this.frames.pop()!
    this.frames[this.frames.length - 1]!.push(...actions)
    this.depth = level
    return value
  }

  /** Runs committed callbacks in order, reporting every one even if an earlier one threw; the first error is rethrown. */
  private runAfterCommit(actions: readonly (() => void)[]): void {
    let failed = false
    let first: unknown
    for (const action of actions) {
      try { action() } catch (error) { if (!failed) { failed = true; first = error } }
    }
    if (failed) throw first
  }

  /**
   * Runs `fn` once the outermost transaction commits, or immediately when no transaction is open. Callbacks registered
   * inside a savepoint or transaction that rolls back are discarded and never run.
   */
  afterCommit(fn: () => void): void {
    if (this.depth > 0) this.frames[this.frames.length - 1]!.push(fn)
    else fn()
  }

  /** Closes the underlying connection (also when it was supplied by the caller). */
  close(): void { this.db.close() }

  private readOne<T>(sql: string, ...parameters: SQLInputValue[]): T | undefined {
    const row: Record<string, SQLOutputValue> | undefined = this.db.prepare(sql).get(...parameters)
    return row === undefined ? undefined : JSON.parse(String(row.value)) as T
  }

  private readMany<T>(sql: string, ...parameters: SQLInputValue[]): T[] {
    return this.db.prepare(sql).all(...parameters).map(row => JSON.parse(String(row.value)) as T)
  }

  /** Whether a component's table exists on this connection; a bare repository may not have created it yet. */
  private hasTable(name: string): boolean {
    return this.db.prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined
  }

  /**
   * Delete a ticket and the rows that only make sense with it, in one transaction.
   *
   * Removed: the ticket row (its assignments and inputs live inside its JSON), the outbox messages queued for it and
   * their `reply` effects, the `launch`/`delivery` effects keyed by its id, its triggers' model choices, and its id in
   * every thread's subscriptions/context. Kept on purpose: `usage_calls` (billing history), `events` (audit), triggers
   * and dispositions, decisions, and threads themselves — they are history and do not depend on the ticket existing.
   *
   * Returns the deleted ticket, or `undefined` when the id is unknown.
   */
  deleteTicket(id: string): Ticket | undefined {
    return this.atomic(() => {
      const ticket = this.tickets.get(id)
      if (!ticket) return undefined

      if (this.hasTable('outbox')) {
        const messages = this.db.prepare('SELECT id FROM outbox WHERE ticket_id = ?').all(id)
        if (messages.length > 0 && this.hasTable('effects')) {
          const removeEffect = this.db.prepare('DELETE FROM effects WHERE kind = ? AND item_key = ?')
          for (const row of messages) removeEffect.run('reply', String(row.id))
        }
        this.db.prepare('DELETE FROM outbox WHERE ticket_id = ?').run(id)
      }
      if (this.hasTable('effects')) {
        this.db.prepare("DELETE FROM effects WHERE kind IN ('launch', 'delivery') AND item_key = ?").run(id)
      }
      // Pull-request (and future) links belong to the ticket; nothing should keep pointing at a deleted one.
      if (this.hasTable('ticket_links')) {
        this.db.prepare('DELETE FROM ticket_links WHERE ticket_id = ?').run(id)
      }
      if (this.hasTable('model_choices')) {
        const removeChoice = this.db.prepare('DELETE FROM model_choices WHERE trigger_id = ?')
        for (const triggerId of new Set([ticket.origin.triggerId, ...ticket.origin.triggerIds])) {
          removeChoice.run(triggerId)
        }
      }

      for (const thread of this.threads.list()) {
        const subscriptions = thread.subscriptions.filter(item => item !== id)
        const context = thread.context?.filter(item => item !== id)
        const changed = subscriptions.length !== thread.subscriptions.length
          || (thread.context !== undefined && context !== undefined && context.length !== thread.context.length)
        if (!changed) continue
        thread.subscriptions = subscriptions
        if (context !== undefined) thread.context = context
        this.threads.save(thread)
      }

      this.db.prepare('DELETE FROM tickets WHERE id = ?').run(id)
      return ticket
    })
  }

  readonly triggers = {
    get: (id: string): Trigger | undefined => this.readOne<Trigger>('SELECT value FROM triggers WHERE id=?', id),
    save: (trigger: Trigger): void => {
      this.db.prepare(`INSERT INTO triggers (id, source, at, value) VALUES (?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET source=excluded.source, at=excluded.at, value=excluded.value`)
        .run(trigger.id, trigger.source, trigger.at, JSON.stringify(trigger))
    },
    disposition: (id: string): TriggerDisposition | undefined =>
      this.readOne<TriggerDisposition>('SELECT value FROM dispositions WHERE id=?', id),
    saveDisposition: (id: string, value: TriggerDisposition): void => {
      this.db.prepare('INSERT INTO dispositions (id, value) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value')
        .run(id, JSON.stringify(value))
    },
  }

  readonly threads = {
    get: (key: string): Thread | undefined => this.readOne<Thread>('SELECT value FROM threads WHERE key=?', key),
    save: (thread: Thread): void => {
      this.db.prepare('INSERT INTO threads (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
        .run(thread.key, JSON.stringify(thread))
    },
    /** Insertion order, oldest first. */
    list: (): Thread[] => this.readMany<Thread>('SELECT value FROM threads ORDER BY rowid'),
    /** Threads with queued Triggers or an Eval in progress, oldest first. */
    active: (): Thread[] => this.readMany<Thread>('SELECT value FROM threads WHERE active = 1 ORDER BY rowid'),
  }

  readonly tickets = {
    get: (id: string): Ticket | undefined => this.readOne<Ticket>('SELECT value FROM tickets WHERE id=?', id),
    save: (ticket: Ticket): void => {
      this.db.prepare('INSERT INTO tickets (id, value) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value')
        .run(ticket.id, JSON.stringify(ticket))
    },
    /** Newest first, matching `MemoryRepositories`. */
    list: (): Ticket[] => this.readMany<Ticket>('SELECT value FROM tickets ORDER BY rowid DESC'),
    /** Open tickets, newest first. */
    open: (): Ticket[] => this.readMany<Ticket>('SELECT value FROM tickets WHERE open = 1 ORDER BY rowid DESC'),
    /** Tickets with undelivered Inputs or a pending or running latest Assignment, newest first. */
    active: (): Ticket[] => this.readMany<Ticket>('SELECT value FROM tickets WHERE active = 1 ORDER BY rowid DESC'),
  }

  readonly decisions = {
    get: (id: string): Decision | undefined => this.readOne<Decision>('SELECT value FROM decisions WHERE id=?', id),
    save: (decision: Decision): void => {
      this.db.prepare(`INSERT INTO decisions (id, thread_key, value) VALUES (?,?,?)
        ON CONFLICT(id) DO UPDATE SET thread_key=excluded.thread_key, value=excluded.value`)
        .run(decision.id, decision.threadKey, JSON.stringify(decision))
    },
    /** A thread's decisions in the order they were recorded. */
    byThread: (key: string): Decision[] =>
      this.readMany<Decision>('SELECT value FROM decisions WHERE thread_key=? ORDER BY rowid', key),
  }
}
