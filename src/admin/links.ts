/**
 * Durable links attached to a ticket, such as the pull requests its worker opened.
 *
 * One row per `(ticket, kind, url)`, so re-reporting the same link does not duplicate it. The table lives beside the
 * other runtime tables on the shared SQLite connection; deleting a ticket removes its rows in
 * `SqliteRepositories.deleteTicket`, so no separate cleanup call is needed.
 */
import type { DatabaseSync, StatementSync } from 'node:sqlite'

export interface TicketLink {
  kind: string
  url: string
  title: string
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS ticket_links (
  ticket_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  url TEXT NOT NULL,
  title TEXT NOT NULL,
  at TEXT NOT NULL,
  PRIMARY KEY (ticket_id, kind, url)
);
CREATE INDEX IF NOT EXISTS ticket_links_ticket ON ticket_links (ticket_id);
`

export interface TicketLinksOptions {
  db: DatabaseSync
  now?: () => string
}

export class TicketLinks {
  private readonly now: () => string
  private readonly insert: StatementSync
  private readonly byTicket: StatementSync
  private readonly deleteTicket: StatementSync

  constructor(options: TicketLinksOptions) {
    this.now = options.now ?? (() => new Date().toISOString())
    options.db.exec(SCHEMA)
    this.insert = options.db.prepare(
      'INSERT INTO ticket_links (ticket_id, kind, url, title, at) VALUES (?, ?, ?, ?, ?) '
      + 'ON CONFLICT(ticket_id, kind, url) DO UPDATE SET title = excluded.title, at = excluded.at',
    )
    this.byTicket = options.db.prepare('SELECT * FROM ticket_links WHERE ticket_id = ? ORDER BY rowid')
    this.deleteTicket = options.db.prepare('DELETE FROM ticket_links WHERE ticket_id = ?')
  }

  add(ticketId: string, link: TicketLink): void {
    this.insert.run(ticketId, link.kind, link.url, link.title, this.now())
  }

  list(ticketId: string): TicketLink[] {
    return this.byTicket.all(ticketId).map(row => ({
      kind: String(row.kind),
      url: String(row.url),
      title: String(row.title),
    }))
  }

  removeTicket(ticketId: string): void {
    this.deleteTicket.run(ticketId)
  }
}
