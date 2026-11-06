/**
 * The durable effect queue: coalescing, per-kind limits, retry backoff,
 * `Later` deferral, in-flight replay, and restart behavior.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Effects, Later, type EffectContext, type EffectsOptions } from '../src/effects/effects.ts'

interface Deferred<T = void> {
  readonly promise: Promise<T>
  readonly resolve: (value: T) => void
}

const deferred = <T = void>(): Deferred<T> => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((settle) => { resolve = settle })
  return { promise, resolve }
}

let directory: string
let databases: DatabaseSync[]
let instances: Effects[]
let effects: Effects
let clock: number

const open = (path: string): DatabaseSync => {
  const database = new DatabaseSync(path)
  databases.push(database)
  return database
}

const make = (database: DatabaseSync, options: EffectsOptions = {}): Effects => {
  const instance = new Effects(database, { now: () => clock, ...options })
  instances.push(instance)
  return instance
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'superagent-effects-'))
  databases = []
  instances = []
  clock = Date.parse('2026-09-09T00:00:00Z')
  effects = make(open(join(directory, 'effects.sqlite')))
  effects.start()
})

afterEach(async () => {
  for (const instance of instances) await instance.drain()
  for (const database of databases) if (database.isOpen) database.close()
  rmSync(directory, { recursive: true, force: true })
})

describe('Effects', () => {
  it('commits and rolls back with the caller transaction', async () => {
    const run = vi.fn(async (_payload: unknown, _context: EffectContext) => {})
    effects.handle('relay', run)

    const database = databases[0]!
    database.exec('BEGIN')
    effects.enqueue('relay', 'kept', { text: 'a' })
    database.exec('COMMIT')
    database.exec('BEGIN')
    effects.enqueue('relay', 'dropped', { text: 'b' })
    database.exec('ROLLBACK')

    await effects.idle()
    expect(run.mock.calls.map((call) => call[1].key)).toEqual(['kept'])
    expect(effects.pending('relay')).toBe(false)
  })

  it('keeps one row per kind and key, replacing the payload without changing queue order', async () => {
    let limit = 0
    const run = vi.fn(async (_payload: unknown, _context: EffectContext) => {})
    effects.handle('launch', run, { limit: () => limit })

    effects.enqueue('launch', 'first', { n: 1 })
    effects.enqueue('launch', 'second', { n: 2 })
    effects.enqueue('launch', 'first', { n: 3 })

    await effects.idle()
    expect(run).not.toHaveBeenCalled()
    expect(effects.pending('launch', 'first')).toBe(true)

    limit = 1
    await effects.idle()
    expect(run.mock.calls.map((call) => call[1].key)).toEqual(['first', 'second'])
    expect(run.mock.calls[0]![0]).toEqual({ n: 3 })
    expect(effects.pending('launch')).toBe(false)
    expect(effects.pending()).toBe(false)
  })

  it('runs at most its concurrency limit at once and never the same row twice', async () => {
    const holds = new Map<string, Deferred>()
    const active = new Set<string>()
    let peak = 0
    const run = vi.fn(async (_payload: unknown, context: EffectContext) => {
      expect(active.has(context.key)).toBe(false)
      active.add(context.key)
      peak = Math.max(peak, active.size)
      const hold = deferred()
      holds.set(context.key, hold)
      await hold.promise
      active.delete(context.key)
    })
    effects.handle('launch', run, { limit: 2 })

    for (const key of ['a', 'b', 'c']) effects.enqueue('launch', key, { key })
    await vi.waitFor(() => expect(run.mock.calls.map((call) => call[1].key)).toEqual(['a', 'b']))
    expect(peak).toBe(2)
    expect(effects.pending('launch', 'c')).toBe(true)

    holds.get('a')!.resolve()
    await vi.waitFor(() => expect(run.mock.calls.map((call) => call[1].key)).toEqual(['a', 'b', 'c']))
    expect(peak).toBe(2)

    holds.get('b')!.resolve()
    holds.get('c')!.resolve()
    await effects.idle()
    expect(effects.pending('launch')).toBe(false)
  })

  it('runs nothing while the limit is 0 and resumes when it rises', async () => {
    let limit = 0
    const run = vi.fn(async () => {})
    effects.handle('delivery', run, { limit: () => limit })

    effects.enqueue('delivery', 'a', {})
    effects.enqueue('delivery', 'b', {})
    await effects.idle()
    expect(run).not.toHaveBeenCalled()
    expect(effects.pending('delivery')).toBe(true)

    limit = 1
    await effects.idle()
    expect(run).toHaveBeenCalledTimes(2)
    expect(effects.pending('delivery')).toBe(false)
  })

  it('retries with doubling backoff capped at the maximum, and reports three consecutive failures', async () => {
    let fail = true
    const run = vi.fn(async () => { if (fail) throw new Error('boom') })
    effects.handle('notice', run, { retry: [1000, 3000] })
    effects.enqueue('notice', 'k', { value: 1 })

    await effects.idle()
    expect(run).toHaveBeenCalledTimes(1)
    expect(effects.failures('notice')).toEqual([])

    // First failure waits 1 s, the second 2 s; the third failure marks the row.
    for (const [index, wait] of [1000, 2000].entries()) {
      clock += wait - 1
      await effects.idle()
      expect(run).toHaveBeenCalledTimes(index + 1)
      clock += 1
      await effects.idle()
      expect(run).toHaveBeenCalledTimes(index + 2)
    }
    const failing = effects.failures('notice')
    expect(failing).toHaveLength(1)
    expect(failing[0]).toMatchObject({ kind: 'notice', key: 'k', attempts: 3, error: 'Error: boom' })
    expect(effects.failures()).toEqual(failing)

    // The fourth wait is capped at 3 s rather than doubling to 4 s.
    clock += 2999
    await effects.idle()
    expect(run).toHaveBeenCalledTimes(3)
    clock += 1
    await effects.idle()
    expect(run).toHaveBeenCalledTimes(4)

    fail = false
    clock += 3000
    await effects.idle()
    expect(effects.pending('notice')).toBe(false)
    expect(effects.failures('notice')).toEqual([])
  })

  it('stops retrying at maxAttempts and keeps the row visible with its last error', async () => {
    const run = vi.fn(async () => { throw new Error('boom') })
    effects.handle('capped', run, { retry: [1000, 3000], maxAttempts: 3 })
    effects.enqueue('capped', 'k', { value: 1 })

    // First failure waits 1 s, the second 2 s; the third is the cap.
    await effects.idle()
    expect(run).toHaveBeenCalledTimes(1)
    clock += 1000
    await effects.idle()
    expect(run).toHaveBeenCalledTimes(2)
    clock += 2000
    await effects.idle()
    expect(run).toHaveBeenCalledTimes(3)

    expect(effects.failures('capped')).toMatchObject([{ kind: 'capped', key: 'k', attempts: 3, error: 'Error: boom' }])
    expect(effects.pending('capped', 'k')).toBe(true)

    // No backoff, however long, ever makes the exhausted row due again.
    clock += 1_000_000
    await effects.idle()
    expect(run).toHaveBeenCalledTimes(3)
    expect(effects.failures('capped')[0]!.attempts).toBe(3)
  })

  it('defers a Later without counting a failure, using its delay (default 5 s)', async () => {
    const run = vi.fn(async () => {
      if (run.mock.calls.length === 1) throw new Later()
      if (run.mock.calls.length === 2) throw new Later(1000)
    })
    // The handler's retry starts at 1 s; a bare Later still waits its own 5 s.
    effects.handle('launch', run, { retry: [1000, 60_000] })
    effects.enqueue('launch', 'a', { ticketId: 't' })

    await effects.idle()
    expect(run).toHaveBeenCalledTimes(1)
    expect(effects.failures('launch')).toEqual([])
    expect(effects.pending('launch', 'a')).toBe(true)

    clock += 4999
    await effects.idle()
    expect(run).toHaveBeenCalledTimes(1)
    clock += 1
    await effects.idle()
    expect(run).toHaveBeenCalledTimes(2)
    expect(effects.failures('launch')).toEqual([])

    // The second deferral carries its own 1 s delay.
    clock += 999
    await effects.idle()
    expect(run).toHaveBeenCalledTimes(2)
    clock += 1
    await effects.idle()
    expect(run).toHaveBeenCalledTimes(3)

    expect(effects.pending('launch')).toBe(false)
    expect(effects.failures('launch')).toEqual([])
  })

  it('keeps a payload enqueued while the row is running', async () => {
    const hold = deferred()
    const run = vi.fn(async (payload: { text: string }) => {
      if (payload.text === 'first') await hold.promise
    })
    effects.handle('relay', run)

    effects.enqueue('relay', 'k', { text: 'first' })
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1))

    effects.enqueue('relay', 'k', { text: 'second' })
    effects.enqueue('relay', 'k', { text: 'third' })
    hold.resolve()
    await effects.idle()

    expect(run.mock.calls.map((call) => (call[0] as { text: string }).text)).toEqual(['first', 'third'])
    expect(effects.pending('relay')).toBe(false)
  })

  it('preserves unfinished rows across drain and a fresh instance on the same database', async () => {
    const path = join(directory, 'effects.sqlite')
    const hold = deferred()
    let entered = false
    effects.handle('relay', async () => {
      entered = true
      await hold.promise
      throw new Error('interrupted')
    })
    effects.enqueue('relay', 'cut', { text: 'a' })
    await vi.waitFor(() => expect(entered).toBe(true))

    const drained = effects.drain()
    effects.enqueue('relay', 'later', { text: 'b' })
    hold.resolve()
    await drained

    // Simulate a process restart: close the database and build a new queue.
    databases[0]!.close()
    const restarted = make(open(path))
    restarted.start()
    const run = vi.fn(async (_payload: unknown, _context: EffectContext) => {})
    restarted.handle('relay', run)
    await restarted.idle()

    expect(run.mock.calls.map((call) => call[1].key)).toEqual(['cut', 'later'])
    expect(restarted.pending('relay')).toBe(false)
  })

  it('dispatches due rows on its polling interval after start', async () => {
    const polling = make(open(join(directory, 'poll.sqlite')), { pollMs: 10 })
    let limit = 0
    const run = vi.fn(async () => {})
    polling.handle('notice', run, { limit: () => limit })
    polling.enqueue('notice', 'n', {})
    polling.start()
    await polling.idle()
    await Promise.resolve()
    expect(run).not.toHaveBeenCalled()

    // Nothing kicks the queue here: only the interval can start the row.
    limit = 1
    await vi.waitFor(() => expect(run).toHaveBeenCalledOnce())
    await vi.waitFor(() => expect(polling.pending('notice')).toBe(false))
  })
})
