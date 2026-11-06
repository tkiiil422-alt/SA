/**
 * The core `Outbox` port on the runtime's SQLite database.
 *
 * A message is one `outbox` row, keyed by its id, so queueing is idempotent. CLI messages also get a durable `reply`
 * effect; its handler marks the row `sent`, which is the whole delivery for the CLI channel. Pending CLI rows are
 * re-enqueued when the runtime starts, so a message queued before a restart still goes out.
 */
import type { DatabaseSync, StatementSync } from 'node:sqlite'
import type { ChannelRef } from '../core/model.ts'
import type { OutboundMessage, Outbox as OutboxPort, ReplyStatus } from '../core/ports.ts'
import type { Effects } from '../effects/effects.ts'

/** Delivery attempts for a non-CLI message before it is marked `failed`. */
const MAX_DELIVERY_ATTEMPTS = 6

export interface OutboxOptions {
  db: DatabaseSync
  effects: Effects
  now?: () => string
  /** Retry delays for a failing channel delivery, in milliseconds (initial, maximum). Default: the effect queue's. */
  retry?: readonly [number, number]
  /** Applied to every message text before it is stored, so a stored secret never reaches a channel or the console. */
  redact?: (text: string) => string
}

/** One stored message, as the control interface reads it. */
export interface StoredMessage {
  id: string
  channel: ChannelRef
  text: string
  kind: OutboundMessage['kind']
  ticketId?: string
  status: ReplyStatus
  createdAt: string
  sentAt?: string
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS outbox (
  id TEXT PRIMARY KEY,
  channel_source TEXT NOT NULL,
  channel_thread TEXT NOT NULL,
  channel_address TEXT NOT NULL,
  text TEXT NOT NULL,
  kind TEXT NOT NULL,
  ticket_id TEXT,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  sent_at TEXT
);
CREATE INDEX IF NOT EXISTS outbox_ticket ON outbox (ticket_id);
CREATE INDEX IF NOT EXISTS outbox_thread ON outbox (channel_source, channel_thread);
`

export class Outbox implements OutboxPort {
  private readonly now: () => string
  private readonly insert: StatementSync
  private readonly statusOf: StatementSync
  private readonly withdrawOne: StatementSync
  private readonly markSentOne: StatementSync
  private readonly byTicket: StatementSync
  private readonly byThread: StatementSync
  private readonly byId: StatementSync
  private readonly markFailedOne: StatementSync
  private readonly pendingOf: StatementSync
  private readonly channels = new Map<string, (message: OutboundMessage) => Promise<void>>()

  constructor(private readonly options: OutboxOptions) {
    this.now = options.now ?? (() => new Date().toISOString())
    options.db.exec(SCHEMA)
    this.insert = options.db.prepare(`
      INSERT OR IGNORE INTO outbox
        (id, channel_source, channel_thread, channel_address, text, kind, ticket_id, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)
    `)
    this.statusOf = options.db.prepare('SELECT status FROM outbox WHERE id = ?')
    this.withdrawOne = options.db.prepare("UPDATE outbox SET status = 'dropped' WHERE id = ? AND status = 'pending'")
    this.markSentOne = options.db.prepare("UPDATE outbox SET status = 'sent', sent_at = ? WHERE id = ? AND status = 'pending'")
    this.byTicket = options.db.prepare('SELECT * FROM outbox WHERE ticket_id = ? ORDER BY rowid')
    this.byThread = options.db.prepare('SELECT * FROM outbox WHERE channel_source = ? AND channel_thread = ? ORDER BY rowid')
    this.byId = options.db.prepare('SELECT * FROM outbox WHERE id = ?')
    this.markFailedOne = options.db.prepare("UPDATE outbox SET status = 'failed' WHERE id = ? AND status = 'pending'")
    this.pendingOf = options.db.prepare("SELECT id FROM outbox WHERE status = 'pending' AND channel_source = ? ORDER BY rowid")

    // One `reply` handler for every channel. The CLI channel's delivery is only marking the row sent. A registered channel
    // calls its deliver function; a failure is rethrown so the effect retries, and the last attempt marks the row failed.
    // The effect is durable, so a crash before the handler ran is recovered by the re-enqueue below.
    options.effects.handle<{ id: string }>('reply', async (payload, context) => {
      const row = this.byId.get(payload.id)
      if (!row) return
      const stored = this.message(row)
      if (stored.status !== 'pending') return
      if (stored.channel.source === 'cli') {
        this.markSentOne.run(this.now(), payload.id)
        return
      }
      const deliver = this.channels.get(stored.channel.source)
      // An unregistered channel keeps its row pending; registering the channel queues it again.
      if (!deliver) return
      try {
        await deliver({
          id: stored.id,
          channel: stored.channel,
          text: stored.text,
          kind: stored.kind,
          ...(stored.ticketId ? { ticketId: stored.ticketId } : {}),
        })
      } catch (error) {
        if (context.attempts + 1 >= MAX_DELIVERY_ATTEMPTS) {
          this.markFailedOne.run(payload.id)
          return
        }
        throw error
      }
      this.markSentOne.run(this.now(), payload.id)
    }, { maxAttempts: MAX_DELIVERY_ATTEMPTS, ...(options.retry ? { retry: options.retry } : {}) })
    for (const row of this.pendingOf.all('cli')) {
      const id = String(row.id)
      options.effects.enqueue('reply', id, { id })
    }
  }

  /**
   * Register the delivery function of a non-CLI channel. Its pending messages are queued again, so messages left over from
   * before a restart are sent. A failing delivery is retried by the effect queue, up to six attempts, then marked `failed`.
   */
  registerChannel(source: string, deliver: (message: OutboundMessage) => Promise<void>): void {
    if (source === 'cli') throw new Error('The cli channel is delivered by the runtime itself')
    if (this.channels.has(source)) throw new Error(`Channel "${source}" already has a delivery function`)
    this.channels.set(source, deliver)
    for (const row of this.pendingOf.all(source)) {
      const id = String(row.id)
      this.options.effects.enqueue('reply', id, { id })
    }
  }

  send(message: OutboundMessage): void {
    const result = this.insert.run(
      message.id,
      message.channel.source,
      message.channel.thread,
      JSON.stringify(message.channel.address),
      this.options.redact?.(message.text) ?? message.text,
      message.kind,
      message.ticketId ?? null,
      this.now(),
    )
    if (Number(result.changes) > 0) {
      this.options.effects.enqueue('reply', message.id, { id: message.id })
    }
  }

  status(id: string): ReplyStatus | undefined {
    const row = this.statusOf.get(id)
    return row === undefined ? undefined : String(row.status) as ReplyStatus
  }

  withdraw(id: string): void {
    this.withdrawOne.run(id)
  }

  /** Messages queued for one ticket, oldest first. */
  messagesForTicket(ticketId: string): StoredMessage[] {
    return this.byTicket.all(ticketId).map(row => this.message(row))
  }

  /** Messages queued on one channel thread, oldest first. */
  messagesForThread(source: string, thread: string): StoredMessage[] {
    return this.byThread.all(source, thread).map(row => this.message(row))
  }

  private message(row: Record<string, unknown>): StoredMessage {
    const ticketId = row.ticket_id === null || row.ticket_id === undefined ? undefined : String(row.ticket_id)
    const sentAt = row.sent_at === null || row.sent_at === undefined ? undefined : String(row.sent_at)
    return {
      id: String(row.id),
      channel: {
        source: String(row.channel_source),
        thread: String(row.channel_thread),
        address: JSON.parse(String(row.channel_address)) as Record<string, string>,
      },
      text: String(row.text),
      kind: String(row.kind) as OutboundMessage['kind'],
      ...(ticketId ? { ticketId } : {}),
      status: String(row.status) as ReplyStatus,
      createdAt: String(row.created_at),
      ...(sentAt ? { sentAt } : {}),
    }
  }
}
