import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { Ledger, type UsageCallInput } from '../src/ledger/ledger.ts'

/** An ISO timestamp for a local wall-clock time; month is 1-based. */
const localIso = (year: number, month: number, day: number, hour = 0, minute = 0, second = 0, millisecond = 0): string =>
  new Date(year, month - 1, day, hour, minute, second, millisecond).toISOString()

const NOW = new Date(2026, 8, 23, 12, 0, 0) // local noon, 2026-09-23

function call(overrides: Partial<UsageCallInput> = {}): UsageCallInput {
  return {
    at: localIso(2026, 9, 23, 10),
    ticketId: 't1',
    model: 'model-a',
    status: 200,
    promptHit: 0,
    promptMiss: 0,
    completion: 0,
    costUsd: 0,
    latencyMs: 250,
    ...overrides,
  }
}

function open(now = NOW): Ledger {
  return new Ledger(new DatabaseSync(':memory:'), { now: () => now })
}

describe('ledger', () => {
  it('records calls and aggregates a ticket with its hit rate', () => {
    const ledger = open()
    ledger.record(call({ promptHit: 30, promptMiss: 70, completion: 50, costUsd: 0.25 }))
    ledger.record(call({ promptHit: 0, promptMiss: 20, completion: 10, costUsd: 0.75 }))

    expect(ledger.ticketTotals('t1')).toEqual({ usd: 1, calls: 2, hit: 30, miss: 90, out: 60, hitRate: 0.25 })
    expect(ledger.ticketTotals('missing')).toEqual({ usd: 0, calls: 0, hit: 0, miss: 0, out: 0, hitRate: 0 })
    expect(ledger.dayTotals()).toEqual({ usd: 1, calls: 2, hit: 30, miss: 90, out: 60, hitRate: 0.25 })
  })

  it('splits days at local midnight', () => {
    const ledger = open()
    ledger.record(call({ at: localIso(2026, 9, 22, 23, 59, 59, 999), ticketId: 'yesterday', costUsd: 0.25 }))
    ledger.record(call({ at: localIso(2026, 9, 23, 0, 0, 0, 0), ticketId: 'today', costUsd: 0.75 }))

    expect(ledger.dayUsd()).toBe(0.75)
    expect(ledger.dayTotals().calls).toBe(1)
    expect(ledger.dayUsd(new Date(2026, 8, 22, 15, 0, 0))).toBe(0.25)
    expect(ledger.dayTotals(new Date(2026, 8, 22, 15, 0, 0))).toMatchObject({ usd: 0.25, calls: 1 })
  })

  it('fills missing days with zero and sorts them ascending', () => {
    const ledger = open()
    ledger.record(call({ at: localIso(2026, 9, 17, 9), promptHit: 10, promptMiss: 10, costUsd: 0.25 }))
    ledger.record(call({ at: localIso(2026, 9, 21, 9), promptHit: 5, promptMiss: 15, costUsd: 0.5 }))
    ledger.record(call({ at: localIso(2026, 9, 23, 9), promptHit: 0, promptMiss: 10, costUsd: 1.5 }))

    const summary = ledger.summary('7d')
    expect(summary.byDay.map(day => day.day)).toEqual([
      '2026-09-17', '2026-09-18', '2026-09-19', '2026-09-20', '2026-09-21', '2026-09-22', '2026-09-23',
    ])
    expect(summary.byDay.map(day => day.usd)).toEqual([0.25, 0, 0, 0, 0.5, 0, 1.5])
    expect(summary.byDay.map(day => day.calls)).toEqual([1, 0, 0, 0, 1, 0, 1])
    expect(summary.byDay.map(day => day.hitRate)).toEqual([0.5, 0, 0, 0, 0.25, 0, 0])
    expect(summary.totals).toEqual({ usd: 2.25, calls: 3, hit: 15, miss: 35, out: 0, hitRate: 0.3 })

    expect(ledger.summary('today').byDay).toEqual([{ day: '2026-09-23', usd: 1.5, calls: 1, hitRate: 0 }])
    expect(ledger.summary('30d').byDay).toHaveLength(30)
    expect(ledger.summary('30d').byDay[0]?.day).toBe('2026-08-25')
  })

  it('ranks models and truncates top tickets at ten', () => {
    const ledger = open()
    for (let index = 1; index <= 12; index += 1) {
      ledger.record(call({
        ticketId: `t${index}`,
        model: index % 2 === 0 ? 'even' : 'odd',
        costUsd: index,
        promptHit: index,
        promptMiss: 0,
      }))
    }

    const summary = ledger.summary('today')
    expect(summary.topTickets.map(ticket => ticket.ticketId)).toEqual([
      't12', 't11', 't10', 't9', 't8', 't7', 't6', 't5', 't4', 't3',
    ])
    expect(summary.topTickets[0]).toEqual({ ticketId: 't12', usd: 12, calls: 1 })
    expect(summary.byModel).toEqual([
      { provider: '', model: 'even', usd: 42, calls: 6, hitRate: 1 },
      { provider: '', model: 'odd', usd: 36, calls: 6, hitRate: 1 },
    ])
  })

  it('paginates calls by id cursor', () => {
    const ledger = open()
    for (let index = 0; index < 5; index += 1) ledger.record(call({ ticketId: 'p', costUsd: index }))

    expect(ledger.calls({ ticketId: 'p', limit: 2 }).map(row => row.id)).toEqual([5, 4])
    expect(ledger.calls({ ticketId: 'p', limit: 2, before: 4 }).map(row => row.id)).toEqual([3, 2])
    expect(ledger.calls({ ticketId: 'p', limit: 2, before: 2 }).map(row => row.id)).toEqual([1])
    expect(ledger.calls({ ticketId: 'p', limit: 0 }).map(row => row.id)).toEqual([5])
    expect(ledger.calls({ ticketId: 'p' })).toHaveLength(5)
    expect(ledger.calls({ ticketId: 'p' })[0]).toMatchObject({ id: 5, ticketId: 'p', costUsd: 4, status: 200 })
  })

  it('records non-2xx calls with zero cost', () => {
    const ledger = open()
    ledger.record(call({ status: 500, costUsd: 0 }))
    ledger.record(call({ status: 429, costUsd: 0 }))

    expect(ledger.calls().map(row => row.status)).toEqual([429, 500])
    expect(ledger.ticketTotals('t1')).toEqual({ usd: 0, calls: 2, hit: 0, miss: 0, out: 0, hitRate: 0 })
  })
})

describe('ledger provider', () => {
  it('stores the provider and groups byModel by provider and model', () => {
    const ledger = open()
    ledger.record(call({ provider: 'p1', model: 'm', costUsd: 1 }))
    ledger.record(call({ provider: 'p2', model: 'm', costUsd: 2 }))
    ledger.record(call({ costUsd: 0.5 }))

    expect(ledger.summary('today').byModel).toEqual([
      { provider: 'p2', model: 'm', usd: 2, calls: 1, hitRate: 0 },
      { provider: 'p1', model: 'm', usd: 1, calls: 1, hitRate: 0 },
      { provider: '', model: 'model-a', usd: 0.5, calls: 1, hitRate: 0 },
    ])
    expect(ledger.calls({ limit: 1 })[0]?.provider).toBe('')
    expect(ledger.calls({ ticketId: 't1', limit: 1 })[0]).toMatchObject({ provider: '' })
  })

  it('counts analysis calls without a ticket in day totals', () => {
    const ledger = open()
    ledger.record(call({ ticketId: '', provider: 'p1', costUsd: 0.25 }))
    expect(ledger.dayUsd()).toBe(0.25)
    expect(ledger.dayTotals().calls).toBe(1)
  })

  it('adds the provider column to an old table and keeps reopening cleanly', () => {
    const db = new DatabaseSync(':memory:')
    db.exec(`
      CREATE TABLE usage_calls (
        id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, ticket_id TEXT NOT NULL, model TEXT NOT NULL,
        status INTEGER NOT NULL, prompt_hit INTEGER NOT NULL, prompt_miss INTEGER NOT NULL, completion INTEGER NOT NULL,
        cost_usd REAL NOT NULL, latency_ms INTEGER NOT NULL
      );
      INSERT INTO usage_calls (at, ticket_id, model, status, prompt_hit, prompt_miss, completion, cost_usd, latency_ms)
        VALUES ('${localIso(2026, 9, 23, 10)}', 't1', 'old', 200, 0, 0, 0, 1, 1);
    `)
    const ledger = new Ledger(db, { now: () => NOW })
    expect(ledger.calls()[0]).toMatchObject({ model: 'old', provider: '' })

    ledger.record(call({ provider: 'p9' }))
    expect(ledger.calls({ limit: 1 })[0]?.provider).toBe('p9')
    expect(() => new Ledger(db, { now: () => NOW })).not.toThrow()
    const columns = db.prepare('PRAGMA table_info(usage_calls)').all().filter(column => column.name === 'provider')
    expect(columns).toHaveLength(1)
  })
})
