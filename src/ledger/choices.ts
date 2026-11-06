/**
 * Per-ticket model choices on the runtime's SQLite database, keyed by trigger id.
 *
 * A person's choice (`person`) is never overwritten by an automatic one (`auto`); a person's choice overwrites anything.
 */
import type { DatabaseSync, StatementSync } from 'node:sqlite'

export type ChoiceSource = 'person' | 'auto'

export interface ModelChoiceInput {
  provider: string
  model: string
  source: ChoiceSource
  reason?: string
}

export interface ModelChoice extends ModelChoiceInput {
  at: string
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS model_choices (
  trigger_id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  source TEXT NOT NULL,
  reason TEXT,
  at TEXT NOT NULL
);
`

export class ModelChoices {
  private readonly now: () => Date
  private readonly upsert: StatementSync
  private readonly select: StatementSync

  constructor(private readonly db: DatabaseSync, now?: () => Date) {
    this.now = now ?? (() => new Date())
    db.exec(SCHEMA)
    this.upsert = db.prepare(`
      INSERT INTO model_choices (trigger_id, provider, model, source, reason, at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (trigger_id) DO UPDATE SET
        provider = excluded.provider,
        model = excluded.model,
        source = excluded.source,
        reason = excluded.reason,
        at = excluded.at
    `)
    this.select = db.prepare('SELECT provider, model, source, reason, at FROM model_choices WHERE trigger_id = ?')
  }

  /** An `auto` choice is dropped when the trigger already has a `person` choice. */
  set(triggerId: string, input: ModelChoiceInput): void {
    if (input.source === 'auto' && this.get(triggerId)?.source === 'person') return
    this.upsert.run(
      triggerId,
      input.provider,
      input.model,
      input.source,
      input.reason ?? null,
      this.now().toISOString(),
    )
  }

  get(triggerId: string): ModelChoice | undefined {
    const row = this.select.get(triggerId)
    if (!row) return undefined
    const reason = row.reason === null || row.reason === undefined ? undefined : String(row.reason)
    return {
      provider: String(row.provider),
      model: String(row.model),
      source: String(row.source) as ChoiceSource,
      ...(reason === undefined ? {} : { reason }),
      at: String(row.at),
    }
  }
}
