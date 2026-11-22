import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { MemoryRepositories } from '../src/core/memory.ts'
import type { Assignment, Decision, Thread, Ticket, Trigger, TriggerDisposition } from '../src/core/model.ts'
import type { Repositories } from '../src/core/ports.ts'
import { SqliteRepositories } from '../src/store/sqlite.ts'

const at = '2026-09-23T00:00:00.000Z'
const actor = { source: 'chat', id: 'alice' }

function trigger(id: string, overrides: Partial<Trigger> = {}): Trigger {
  return { id, source: 'chat', threads: [{ source: 'chat', id: 't1' }], actor, human: true, at, text: `message ${id}`,
    channel: { source: 'chat', thread: 't1', address: { message: id } }, meta: {}, ...overrides }
}
function thread(key: string, overrides: Partial<Thread> = {}): Thread {
  const [source, id] = key.split(':') as [string, string]
  return { key, ref: { source, id }, createdAt: at, subscriptions: [], correlated: [], pending: [], meta: {}, ...overrides }
}
function assignment(id: string, state: Assignment['state']): Assignment {
  return { id, state, createdAt: at, ...state === 'pending' ? {} : { startedAt: at },
    ...state === 'ended' ? { endedAt: at, endedReason: 'done' } : {} }
}
function ticket(id: string, overrides: Partial<Ticket> = {}): Ticket {
  return { id, title: 'Fix', decisionId: 'decision-1', mandate: { strength: 'explicit', policyVersion: 'v1',
    basis: { via: 'listed' }, actor, scope: 'small' }, channels: [], assignments: [], inputs: [], undelivered: [],
  createdAt: at, updatedAt: at, origin: { triggerId: 'trigger-1', triggerIds: ['trigger-1'] }, ...overrides }
}
function decision(id: string, overrides: Partial<Decision> = {}): Decision {
  return { id, evalId: 'eval-1', threadKey: 'chat:t1', triggerIds: ['trigger-1'], policyVersion: 'v1', at, kind: 'ignore',
    reason: [], strength: 'explicit', ...overrides }
}
const disposition = (overrides: Partial<TriggerDisposition> = {}): TriggerDisposition => ({ fanout: [], at, ...overrides })

const opened: SqliteRepositories[] = []
/** Opens a store and registers it for cleanup, so connections never outlive a test. */
function open(source: string | DatabaseSync = ':memory:'): SqliteRepositories {
  const repo = new SqliteRepositories(source)
  opened.push(repo)
  return repo
}
afterEach(() => {
  for (const repo of opened.splice(0)) if (repo.db.isOpen) repo.close()
})

describe('repositories', () => {
  it('round-trips every entity and leaves missing keys undefined', () => {
    const repo = open()
    expect([repo.triggers.get('missing'), repo.threads.get('chat:missing'), repo.tickets.get('missing'),
      repo.decisions.get('missing'), repo.triggers.disposition('missing')]).toEqual([undefined, undefined, undefined,
      undefined, undefined])

    repo.triggers.save(trigger('trigger-1'))
    repo.triggers.saveDisposition('trigger-1', disposition({ evalId: 'eval-1' }))
    repo.threads.save(thread('chat:t1'))
    repo.tickets.save(ticket('ticket-1'))
    repo.decisions.save(decision('decision-1'))

    expect(repo.triggers.get('trigger-1')).toEqual(trigger('trigger-1'))
    expect(repo.triggers.disposition('trigger-1')).toEqual(disposition({ evalId: 'eval-1' }))
    expect(repo.threads.get('chat:t1')).toEqual(thread('chat:t1'))
    expect(repo.threads.list()).toEqual([thread('chat:t1')])
    expect(repo.tickets.get('ticket-1')).toEqual(ticket('ticket-1'))
    expect(repo.tickets.list()).toEqual([ticket('ticket-1')])
    expect(repo.decisions.get('decision-1')).toEqual(decision('decision-1'))
    expect(repo.decisions.byThread('chat:t1')).toEqual([decision('decision-1')])
  })

  it('returns copies: mutating a returned entity does not change stored state', () => {
    const implementations: [string, Repositories][] = [['memory', new MemoryRepositories()], ['sqlite', open()]]
    for (const [name, repo] of implementations) {
      repo.triggers.save(trigger('trigger-1', { meta: { nested: { value: 1 } } }))
      repo.triggers.saveDisposition('trigger-1', disposition({ fanout: ['ticket-1'] }))
      repo.threads.save(thread('chat:t1', { pending: ['trigger-1'], meta: { nested: { value: 1 } } }))
      repo.tickets.save(ticket('ticket-1', { undelivered: ['input-1'], inputs: [{ id: 'input-1', kind: 'text', text: 'x', at }] }))
      repo.decisions.save(decision('decision-1', { audit: { nested: { value: 1 } } }))

      const storedTrigger = repo.triggers.get('trigger-1')!
      ;(storedTrigger.meta.nested as { value: number }).value = 99
      storedTrigger.threads[0]!.id = 'changed'
      repo.triggers.disposition('trigger-1')!.fanout.push('changed')
      repo.threads.get('chat:t1')!.pending.push('changed')
      repo.tickets.get('ticket-1')!.inputs.push({ id: 'changed', kind: 'text', text: 'x', at })
      repo.decisions.get('decision-1')!.audit!.nested = { value: 99 }

      expect(repo.triggers.get('trigger-1')!.meta, name).toEqual({ nested: { value: 1 } })
      expect(repo.triggers.get('trigger-1')!.threads, name).toEqual([{ source: 'chat', id: 't1' }])
      expect(repo.triggers.disposition('trigger-1')!.fanout, name).toEqual(['ticket-1'])
      expect(repo.threads.get('chat:t1')!.pending, name).toEqual(['trigger-1'])
      expect(repo.tickets.get('ticket-1')!.inputs.map(input => input.id), name).toEqual(['input-1'])
      expect(repo.decisions.get('decision-1')!.audit, name).toEqual({ nested: { value: 1 } })
    }
  })

  it('orders and filters tickets and threads exactly like MemoryRepositories', () => {
    const build = (repo: Repositories) => {
      // Newest first: t5, t4, t3, t2, t1. Updating t1 must not move it.
      repo.tickets.save(ticket('t1', { assignments: [assignment('a1', 'running')] }))
      repo.tickets.save(ticket('t2', { assignments: [assignment('a2', 'pending')] }))
      repo.tickets.save(ticket('t3', { assignments: [assignment('a3', 'ended')], undelivered: ['input-3'],
        ended: { at, by: 'executor', outcome: 'completed' } }))
      repo.tickets.save(ticket('t4', { assignments: [assignment('a4', 'ended')], ended: { at, by: 'executor', outcome: 'dropped' } }))
      repo.tickets.save(ticket('t5', { assignments: [assignment('a5', 'ended')] }))
      repo.tickets.save(ticket('t1', { assignments: [assignment('a1', 'running')], title: 'Fix again' }))

      repo.threads.save(thread('chat:th1', { pending: ['trigger-1'] }))
      repo.threads.save(thread('chat:th2', { evaluating: { id: 'eval-1', threadKey: 'chat:th2', triggerIds: ['trigger-1'],
        strength: 'explicit', actor, basis: { via: 'listed' }, policyVersion: 'v1', startedAt: at, deadline: at } }))
      repo.threads.save(thread('chat:th3'))
      repo.threads.save(thread('chat:th4', { pending: [] }))
      return {
        tickets: repo.tickets.list().map(item => item.id),
        open: repo.tickets.open().map(item => item.id),
        active: repo.tickets.active().map(item => item.id),
        threads: repo.threads.list().map(item => item.key),
        activeThreads: repo.threads.active().map(item => item.key),
      }
    }
    const memory = new MemoryRepositories()
    const sqlite = open()
    const expected = {
      tickets: ['t5', 't4', 't3', 't2', 't1'],
      open: ['t5', 't2', 't1'],
      active: ['t3', 't2', 't1'],
      threads: ['chat:th1', 'chat:th2', 'chat:th3', 'chat:th4'],
      activeThreads: ['chat:th1', 'chat:th2'],
    }
    expect(build(memory)).toEqual(expected)
    expect(build(sqlite)).toEqual(expected)
    expect(build(sqlite)).toEqual(build(memory))
  })
})

describe('atomic', () => {
  it('rolls back every write when the work throws, and rethrows the error', () => {
    const repo = open()
    repo.triggers.save(trigger('before'))
    expect(() => repo.atomic(() => {
      repo.triggers.save(trigger('inside'))
      repo.tickets.save(ticket('inside'))
      throw new Error('boom')
    })).toThrow('boom')
    expect(repo.triggers.get('inside')).toBeUndefined()
    expect(repo.tickets.get('inside')).toBeUndefined()
    expect(repo.triggers.get('before')).toBeDefined()
  })

  it('commits on success and returns the work value', () => {
    const repo = open()
    expect(repo.atomic(() => { repo.triggers.save(trigger('inside')); return 42 })).toBe(42)
    expect(repo.triggers.get('inside')).toBeDefined()
  })

  it('rolls back only the inner savepoint when the outer work catches its failure', () => {
    const repo = open()
    repo.atomic(() => {
      repo.triggers.save(trigger('outer'))
      expect(() => repo.atomic(() => {
        repo.triggers.save(trigger('inner'))
        repo.threads.save(thread('chat:inner'))
        throw new Error('inner failed')
      })).toThrow('inner failed')
      repo.triggers.save(trigger('outer-2'))
    })
    expect(repo.triggers.get('outer')).toBeDefined()
    expect(repo.triggers.get('outer-2')).toBeDefined()
    expect(repo.triggers.get('inner')).toBeUndefined()
    expect(repo.threads.get('chat:inner')).toBeUndefined()
  })

  it('commits nested successful savepoints together, and lets an inner failure propagate', () => {
    const repo = open()
    repo.atomic(() => {
      repo.triggers.save(trigger('outer'))
      repo.atomic(() => {
        repo.triggers.save(trigger('inner'))
        repo.atomic(() => { repo.threads.save(thread('chat:deep')) })
      })
    })
    expect([repo.triggers.get('outer'), repo.triggers.get('inner'), repo.threads.get('chat:deep')])
      .toEqual([trigger('outer'), trigger('inner'), thread('chat:deep')])

    expect(() => repo.atomic(() => {
      repo.atomic(() => { repo.triggers.save(trigger('never')); throw new Error('deep') })
    })).toThrow('deep')
    expect(repo.triggers.get('never')).toBeUndefined()
  })
})

describe('afterCommit', () => {
  it('runs after the outermost commit, never before it, and not at all on rollback', () => {
    const repo = open()
    const events: string[] = []
    repo.atomic(() => {
      repo.triggers.save(trigger('1'))
      repo.afterCommit(() => events.push('committed'))
      expect(events).toEqual([])
    })
    expect(events).toEqual(['committed'])

    expect(() => repo.atomic(() => {
      repo.afterCommit(() => events.push('rolled-back'))
      throw new Error('nope')
    })).toThrow('nope')
    expect(events).toEqual(['committed'])
  })

  it('runs immediately outside a transaction', () => {
    const repo = open()
    const events: string[] = []
    repo.afterCommit(() => events.push('immediate'))
    expect(events).toEqual(['immediate'])
  })

  it('defers nested callbacks to the outer commit and drops those of a failed savepoint', () => {
    const repo = open()
    const events: string[] = []
    repo.atomic(() => {
      repo.afterCommit(() => events.push('outer'))
      repo.atomic(() => repo.afterCommit(() => events.push('inner')))
      expect(events).toEqual([])
      expect(() => repo.atomic(() => {
        repo.afterCommit(() => events.push('dropped'))
        throw new Error('inner')
      })).toThrow('inner')
      events.push('work-done')
    })
    expect(events).toEqual(['work-done', 'outer', 'inner'])
  })

  it('discards callbacks queued by nested work when the outer transaction rolls back', () => {
    const repo = open()
    const events: string[] = []
    expect(() => repo.atomic(() => {
      repo.atomic(() => repo.afterCommit(() => events.push('nested')))
      throw new Error('outer')
    })).toThrow('outer')
    expect(events).toEqual([])
  })
})

describe('file persistence', () => {
  it('keeps every repository after close and reopen, and records schema version 1', () => {
    const directory = mkdtempSync(join(tmpdir(), 'superagent-store-'))
    const path = join(directory, 'state.db')
    try {
      const first = open(path)
      expect(String(first.db.prepare('PRAGMA journal_mode').get()?.journal_mode)).toBe('wal')
      expect(Number(first.db.prepare('PRAGMA foreign_keys').get()?.foreign_keys)).toBe(1)
      expect(Number(first.db.prepare('PRAGMA busy_timeout').get()?.timeout)).toBe(5_000)
      first.triggers.save(trigger('trigger-1'))
      first.triggers.saveDisposition('trigger-1', disposition({ fanout: ['ticket-1'] }))
      first.threads.save(thread('chat:t1', { pending: ['trigger-1'] }))
      first.tickets.save(ticket('ticket-1', { undelivered: ['input-1'] }))
      first.decisions.save(decision('decision-1', { threadKey: 'chat:t1' }))
      first.close()

      const second = open(path)
      expect(Number(second.db.prepare('PRAGMA user_version').get()?.user_version)).toBe(1)
      expect(second.triggers.get('trigger-1')).toEqual(trigger('trigger-1'))
      expect(second.triggers.disposition('trigger-1')).toEqual(disposition({ fanout: ['ticket-1'] }))
      expect(second.threads.get('chat:t1')).toEqual(thread('chat:t1', { pending: ['trigger-1'] }))
      expect(second.threads.active().map(item => item.key)).toEqual(['chat:t1'])
      expect(second.tickets.get('ticket-1')).toEqual(ticket('ticket-1', { undelivered: ['input-1'] }))
      expect(second.tickets.active().map(item => item.id)).toEqual(['ticket-1'])
      expect(second.decisions.byThread('chat:t1')).toEqual([decision('decision-1', { threadKey: 'chat:t1' })])
      second.close()
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('accepts an existing DatabaseSync and closes it with the store', () => {
    const db = new DatabaseSync(':memory:')
    const repo = open(db)
    expect(repo.db).toBe(db)
    repo.triggers.save(trigger('trigger-1'))
    expect(Number(db.prepare('SELECT COUNT(*) AS count FROM triggers').get()?.count)).toBe(1)
    repo.close()
    expect(db.isOpen).toBe(false)
  })
})
