/**
 * The Pi executor against a real Engine, SQLite repositories, the durable effect queue, and the fake Pi RPC process.
 * Each test drives the domain through Engine commands and waits on observable state with polling, never fixed sleeps.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Engine, runningAssignment } from '../src/core/index.ts'
import type { Assessor, Candidate, EngineOptions, OutboundMessage, Policy, Ticket, Trigger } from '../src/core/index.ts'
import { Effects } from '../src/effects/effects.ts'
import { PiExecutor } from '../src/executor/pi-executor.ts'
import { SqliteRepositories } from '../src/store/sqlite.ts'

const FAKE_PI = fileURLToPath(new URL('./fixtures/fake-pi.mjs', import.meta.url))
/**
 * Minimal RPC endpoint for the delivery-retry test: the first prompt starts a turn that settles; every later prompt and
 * any steer/follow-up fails, which is the failure the delivery handler retries.
 */
const FAILING_DELIVERY_PI = `
import { appendFileSync } from 'node:fs'
let buffer = ''
let prompts = 0
const logFile = process.env.FAKE_PI_LOG
const send = record => process.stdout.write(JSON.stringify(record) + '\\n')
const log = command => {
  if (!logFile) return
  try {
    appendFileSync(logFile, JSON.stringify({
      command: command.type,
      ...(typeof command.message === 'string' ? { message: command.message } : {}),
    }) + '\\n')
  } catch {}
}
const respond = (id, command, data, error) => {
  const record = { type: 'response', command, success: error === undefined }
  if (id !== undefined) record.id = id
  if (error !== undefined) record.error = error
  else if (data !== undefined) record.data = data
  send(record)
}
process.stdin.setEncoding('utf8')
process.stdin.on('data', chunk => {
  buffer += chunk
  for (;;) {
    const index = buffer.indexOf('\\n')
    if (index === -1) return
    const line = buffer.slice(0, index)
    buffer = buffer.slice(index + 1)
    if (!line) continue
    const command = JSON.parse(line)
    if (command.type === 'prompt' || command.type === 'steer' || command.type === 'follow_up') log(command)
    if (command.type === 'prompt') {
      prompts += 1
      if (prompts === 1) {
        respond(command.id, 'prompt', { disposition: 'started' })
        setTimeout(() => {
          send({ type: 'agent_end', messages: [], willRetry: false })
          send({ type: 'agent_settled', aborted: false })
        }, 10)
      } else {
        respond(command.id, 'prompt', undefined, 'delivery refused')
      }
    } else if (command.type === 'steer' || command.type === 'follow_up') {
      respond(command.id, command.type, undefined, 'delivery refused')
    } else if (command.type === 'abort') {
      respond(command.id, 'abort')
    } else {
      respond(command.id, command.type, { isStreaming: false })
    }
  }
})
process.stdin.on('end', () => process.exit(0))
`
/**
 * RPC endpoint whose prompts report `handled` (no run started, so no `agent_settled` arrives). With
 * `FAKE_PI_HANDLED_MODE=delivery` the first prompt still runs and settles, so a later delivery prompt is the handled one.
 */
const HANDLED_PI = `
import { appendFileSync } from 'node:fs'
const mode = process.env.FAKE_PI_HANDLED_MODE ?? 'launch'
let buffer = ''
let prompts = 0
const logFile = process.env.FAKE_PI_LOG
const send = record => process.stdout.write(JSON.stringify(record) + '\\n')
const log = command => {
  if (!logFile) return
  try {
    appendFileSync(logFile, JSON.stringify({
      command: command.type,
      ...(typeof command.message === 'string' ? { message: command.message } : {}),
    }) + '\\n')
  } catch {}
}
const respond = (id, command, data, error) => {
  const record = { type: 'response', command, success: error === undefined }
  if (id !== undefined) record.id = id
  if (error !== undefined) record.error = error
  else if (data !== undefined) record.data = data
  send(record)
}
process.stdin.setEncoding('utf8')
process.stdin.on('data', chunk => {
  buffer += chunk
  for (;;) {
    const index = buffer.indexOf('\\n')
    if (index === -1) return
    const line = buffer.slice(0, index)
    buffer = buffer.slice(index + 1)
    if (!line) continue
    const command = JSON.parse(line)
    if (command.type === 'prompt' || command.type === 'steer' || command.type === 'follow_up') log(command)
    if (command.type === 'prompt') {
      prompts += 1
      if (mode === 'delivery' && prompts === 1) {
        respond(command.id, 'prompt', { disposition: 'started' })
        setTimeout(() => {
          send({ type: 'agent_end', messages: [], willRetry: false })
          send({ type: 'agent_settled', aborted: false })
        }, 10)
      } else {
        respond(command.id, 'prompt', { disposition: 'handled' })
      }
    } else if (command.type === 'steer' || command.type === 'follow_up') {
      respond(command.id, command.type, { disposition: 'handled' })
    } else if (command.type === 'abort') {
      respond(command.id, 'abort')
    } else {
      respond(command.id, command.type, { isStreaming: false })
    }
  }
})
process.stdin.on('end', () => process.exit(0))
`
/**
 * RPC endpoint for idle-retirement tests: each prompt starts a run that settles after a few milliseconds, and the process
 * appends its exit code to `FAKE_PI_EXIT_LOG` when it goes away, so a test can see that it exited rather than ended a turn.
 */
const IDLE_PI = `
import { appendFileSync } from 'node:fs'
let buffer = ''
const logFile = process.env.FAKE_PI_LOG
const exitFile = process.env.FAKE_PI_EXIT_LOG
const send = record => process.stdout.write(JSON.stringify(record) + '\\n')
const log = command => {
  if (!logFile) return
  try {
    appendFileSync(logFile, JSON.stringify({
      command: command.type,
      ...(typeof command.message === 'string' ? { message: command.message } : {}),
    }) + '\\n')
  } catch {}
}
const respond = (id, command, data, error) => {
  const record = { type: 'response', command, success: error === undefined }
  if (id !== undefined) record.id = id
  if (error !== undefined) record.error = error
  else if (data !== undefined) record.data = data
  send(record)
}
if (exitFile) process.on('exit', code => {
  try { appendFileSync(exitFile, JSON.stringify({ code }) + '\\n') } catch {}
})
process.stdin.setEncoding('utf8')
process.stdin.on('data', chunk => {
  buffer += chunk
  for (;;) {
    const index = buffer.indexOf('\\n')
    if (index === -1) return
    const line = buffer.slice(0, index)
    buffer = buffer.slice(index + 1)
    if (!line) continue
    const command = JSON.parse(line)
    if (command.type === 'prompt' || command.type === 'steer' || command.type === 'follow_up' || command.type === 'abort') log(command)
    if (command.type === 'prompt') {
      respond(command.id, 'prompt', { disposition: 'started' })
      setTimeout(() => {
        send({ type: 'agent_end', messages: [], willRetry: false })
        send({ type: 'agent_settled', aborted: false })
      }, 10)
    } else if (command.type === 'abort') {
      respond(command.id, 'abort')
    } else {
      respond(command.id, command.type, { isStreaming: false })
    }
  }
})
process.stdin.on('end', () => process.exit(0))
`
const member = { source: 'chat', id: 'alice' }
const guest = { source: 'chat', id: 'guest' }

function trigger(id: string, overrides: Partial<Trigger> = {}): Trigger {
  return {
    id,
    source: 'chat',
    threads: [{ source: 'chat', id: 't1' }],
    actor: member,
    human: true,
    at: `2026-09-23T00:00:${id.padStart(2, '0')}Z`,
    text: `message ${id}`,
    channel: { source: 'chat', thread: 't1', address: { message: id } },
    meta: {},
    ...overrides,
  }
}

interface SystemOptions {
  maxSlots?: number
  env?: (ticket: Ticket) => Record<string, string>
  prepare?: (ticket: Ticket) => Promise<void>
  /** Overrides the fake Pi script, for tests that need a custom RPC endpoint. */
  script?: string
  /** Watchdog for a turn that never settles. */
  turnTimeoutMs?: number
  /** Clock for the effect queue, so retry backoff can be driven without real waiting. */
  now?: () => number
}

interface LaunchRecord { ticketId: string; assignmentId: string; env: Record<string, string>; resume: boolean }

interface System {
  repo: SqliteRepositories
  effects: Effects
  engine: Engine
  executor: PiExecutor
  requests: Candidate[]
  launches: LaunchRecord[]
}

const systems: System[] = []
const directories: string[] = []

function tempDir(): string {
  const directory = mkdtempSync(join(tmpdir(), 'superagent-pi-'))
  directories.push(directory)
  return directory
}

function createSystem(path: string, options: SystemOptions = {}): System {
  const repo = new SqliteRepositories(path)
  const effects = new Effects(repo.db, { pollMs: 10, ...(options.now ? { now: options.now } : {}) })
  const requests: Candidate[] = []
  const launches: LaunchRecord[] = []
  const outbox: OutboundMessage[] = []
  const assessor: Assessor = { request: candidate => { requests.push(candidate) }, release: () => {} }
  const policy: Policy = {
    version: 'v1',
    paused: false,
    evalTimeoutMs: 60_000,
    gate: (received, thread) => !received.human
      ? { admissible: false, reason: 'not human' }
      : received.actor.id === 'alice'
        ? { admissible: true, strength: 'explicit', basis: { via: 'listed' } }
        : thread.subscriptions.length
          ? { admissible: true, strength: 'inferred', basis: { via: 'followup' } }
          : { admissible: false, reason: 'not a member' },
    revalidate: () => true,
    admitsInferred: rules => rules.length > 0,
  }
  const scope: EngineOptions['scope'] = { scope: () => ({ listened: true, observed: false }) }
  const queued: EngineOptions['outbox'] = {
    send: message => { if (!outbox.some(item => item.id === message.id)) outbox.push(message) },
    status: id => outbox.some(item => item.id === id) ? 'pending' : undefined,
    withdraw: () => {},
  }
  let engine!: Engine
  const executor = new PiExecutor({
    effects,
    engine: () => engine,
    launcher: (ticket, assignment, context) => {
      const env = { ...(options.env?.(ticket) ?? {}) }
      launches.push({ ticketId: ticket.id, assignmentId: assignment.id, env, resume: context.resume })
      return { command: process.execPath, args: [options.script ?? FAKE_PI], env }
    },
    ...(options.prepare ? { prepare: options.prepare } : {}),
    ...(options.turnTimeoutMs !== undefined ? { turnTimeoutMs: options.turnTimeoutMs } : {}),
    maxSlots: options.maxSlots ?? 2,
    graceMs: 200,
    atomic: work => repo.atomic(work),
    afterCommit: fn => repo.afterCommit(fn),
    tickets: repo.tickets,
    triggers: repo.triggers,
  })
  engine = new Engine({ repo, scope, policy: () => policy, assessor, executor, outbox: queued })
  effects.start()
  const system: System = { repo, effects, engine, executor, requests, launches }
  systems.push(system)
  return system
}

function accept(system: System, id = '1', thread = 't1', title = 'Fix'): string {
  system.engine.receive(trigger(id, { threads: [{ source: 'chat', id: thread }] }))
  system.engine.evaluateDue()
  const candidate = system.requests.at(-1)!
  const decision = system.engine.decide(candidate.triggers[0]!.id, {
    kind: 'accept', title, scope: 'small', reason: 'requested', evalId: candidate.evalId,
  })
  return decision.ticketId!
}

async function until(check: () => boolean, label: string, timeoutMs = 4_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`)
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

const running = (system: System, ticketId: string) => runningAssignment(system.repo.tickets.get(ticketId)!)

function logRecords(path: string): { command: string; message?: string }[] {
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as { command: string; message?: string })
}

function exitRecords(path: string): { code: number }[] {
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as { code: number })
}

afterEach(async () => {
  for (const system of systems.splice(0).reverse()) {
    try { await system.effects.drain() } catch { /* already drained */ }
    try { await system.executor.close() } catch { /* already closed */ }
    try { if (system.repo.db.isOpen) system.repo.close() } catch { /* already closed */ }
  }
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('PiExecutor', () => {
  it('launches a Pi process for an accepted assignment and prompts it with the ticket brief', async () => {
    const directory = tempDir()
    const log = join(directory, 'pi.log')
    const system = createSystem(':memory:', { env: () => ({ FAKE_PI_LOG: log, FAKE_PI_RUN_MS: '80' }) })
    const ticketId = accept(system)

    await until(() => !!running(system, ticketId), 'the assignment to run')
    await until(() => logRecords(log).some(record => record.command === 'prompt'), 'the assignment prompt')

    const prompt = logRecords(log).find(record => record.command === 'prompt')!
    expect(JSON.parse(prompt.message!)).toMatchObject({
      ticket_id: ticketId, trigger_id: '1', title: 'Fix', scope: 'small', request: 'message 1',
    })
    expect(system.launches).toHaveLength(1)
    expect(system.launches[0]!.ticketId).toBe(ticketId)
    expect(system.repo.tickets.get(ticketId)!.assignments[0]!.startedAt).toBeDefined()
  })

  it('reports the end of a turn when Pi settles', async () => {
    const directory = tempDir()
    const log = join(directory, 'pi.log')
    const system = createSystem(':memory:', { env: () => ({ FAKE_PI_LOG: log, FAKE_PI_RUN_MS: '40' }) })
    const ticketId = accept(system)

    await until(() => !!running(system, ticketId)?.idleAt, 'turnEnded')

    expect(running(system, ticketId)!.idleAt).toBeDefined()
    expect(running(system, ticketId)!.report).toBeUndefined()
  })

  it('ends the ticket when the worker reports ready through the Engine', async () => {
    const directory = tempDir()
    const log = join(directory, 'pi.log')
    const system = createSystem(':memory:', { env: () => ({ FAKE_PI_LOG: log, FAKE_PI_RUN_MS: '40' }) })
    const ticketId = accept(system)

    await until(() => !!running(system, ticketId), 'the assignment to run')
    system.engine.report(ticketId, { state: 'ready', summary: 'done' })

    expect(system.repo.tickets.get(ticketId)!.ended).toMatchObject({ by: 'executor', outcome: 'completed' })
  })

  it('steers a running worker with a person follow-up instead of prompting it', async () => {
    const directory = tempDir()
    const log = join(directory, 'pi.log')
    const system = createSystem(':memory:', { env: () => ({ FAKE_PI_LOG: log, FAKE_PI_RUN_MS: '800' }) })
    const ticketId = accept(system)

    await until(() => !!running(system, ticketId), 'the assignment to run')
    await until(() => logRecords(log).some(record => record.command === 'prompt'), 'the assignment prompt')
    system.engine.receive(trigger('2', { actor: guest }))

    await until(() => logRecords(log).some(record => record.command === 'steer'), 'a steer command')
    const steer = logRecords(log).find(record => record.command === 'steer')!
    expect(steer.message).toContain('message 2')
    expect(logRecords(log).some(record => record.command === 'follow_up')).toBe(false)
    await until(() => system.repo.tickets.get(ticketId)!.undelivered.length === 0, 'the input delivery')
  })

  it('queues a second ticket until the first frees its slot, then launches it', async () => {
    const directory = tempDir()
    const logA = join(directory, 'a.log')
    const logB = join(directory, 'b.log')
    const system = createSystem(':memory:', {
      maxSlots: 1,
      env: ticket => ({ FAKE_PI_LOG: ticket.title === 'A' ? logA : logB, FAKE_PI_RUN_MS: ticket.title === 'A' ? '5000' : '40' }),
    })
    const first = accept(system, '1', 't1', 'A')
    await until(() => !!running(system, first), 'the first assignment to run')
    const second = accept(system, '2', 't2', 'B')

    // Let the queued launch run: it finds no slot and defers without starting a process.
    await system.effects.idle('launch')
    expect(running(system, second)).toBeUndefined()
    expect(system.launches.filter(launch => launch.ticketId === second)).toHaveLength(0)

    system.engine.report(first, { state: 'ready', summary: 'done' })
    await until(() => !!running(system, second), 'the second assignment to run')

    expect(system.launches.filter(launch => launch.ticketId === second)).toHaveLength(1)
    expect(system.repo.tickets.get(first)!.ended?.outcome).toBe('completed')
  })

  it('reports failed when the Pi process crashes before a final report', async () => {
    const system = createSystem(':memory:', {
      env: () => ({ FAKE_PI_CRASH: '1', FAKE_PI_CRASH_EXIT_CODE: '7' }),
    })
    const ticketId = accept(system)

    await until(() => system.repo.tickets.get(ticketId)!.assignments[0]?.report?.state === 'failed', 'the failed report')
    const report = system.repo.tickets.get(ticketId)!.assignments[0]!.report!
    expect(report.state).toBe('failed')
    expect(report.summary).toContain('code=7')
    expect(report.summary).toContain('simulated crash')
  })

  it('resumes an interrupted running assignment from a file database after a restart', async () => {
    const directory = tempDir()
    const path = join(directory, 'state.sqlite')
    const log = join(directory, 'pi.log')
    const env = () => ({ FAKE_PI_LOG: log, FAKE_PI_RUN_MS: '5000' })

    const first = createSystem(path, { env })
    const ticketId = accept(first)
    await until(() => !!running(first, ticketId), 'the first assignment to run')
    await until(() => logRecords(log).filter(record => record.command === 'prompt').length >= 1, 'the first prompt')

    // Shut the whole system down, then rebuild it on the same database.
    await first.effects.drain()
    await first.executor.close()
    first.repo.close()

    const second = createSystem(path, { env })
    second.executor.resume()

    await until(() => second.repo.tickets.get(ticketId)!.assignments.length === 2, 'the restarted assignment')
    await until(() => !!running(second, ticketId), 'the restarted assignment to run')
    const ticket = second.repo.tickets.get(ticketId)!
    expect(ticket.assignments[0]).toMatchObject({ state: 'ended', endedReason: 'hostRestarted' })
    expect(ticket.assignments[1]!.state).toBe('running')
    expect(second.launches).toHaveLength(1)
    await until(() => logRecords(log).filter(record => record.command === 'prompt').length >= 2, 'the second prompt')
  })

  it('frees the slot when Pi handles a launch prompt without starting a run', async () => {
    const directory = tempDir()
    const log = join(directory, 'pi.log')
    const script = join(directory, 'handled-pi.mjs')
    writeFileSync(script, HANDLED_PI)
    const system = createSystem(':memory:', { script, maxSlots: 1, env: () => ({ FAKE_PI_LOG: log }) })

    accept(system, '1', 't1', 'A')
    await until(() => logRecords(log).some(record => record.command === 'prompt' && record.message?.includes('"title":"A"')), 'the first prompt')
    const second = accept(system, '2', 't2', 'B')

    // A `handled` prompt produces no `agent_settled`; without releasing the slot, B could never launch.
    await until(() => logRecords(log).some(record => record.command === 'prompt' && record.message?.includes('"title":"B"')), 'the second prompt')
    expect(system.launches.filter(launch => launch.ticketId === second)).toHaveLength(1)
  })

  it('frees the slot when Pi handles a delivered input without starting a run', async () => {
    const directory = tempDir()
    const log = join(directory, 'pi.log')
    const script = join(directory, 'handled-pi.mjs')
    writeFileSync(script, HANDLED_PI)
    const system = createSystem(':memory:', {
      script,
      maxSlots: 1,
      env: () => ({ FAKE_PI_LOG: log, FAKE_PI_HANDLED_MODE: 'delivery' }),
    })

    const first = accept(system, '1', 't1', 'A')
    await until(() => !!running(system, first)?.idleAt, 'the first turn to settle')
    system.engine.receive(trigger('2', { actor: guest }))
    await until(() => logRecords(log).filter(record => record.command === 'prompt').length >= 2, 'the handled delivery prompt')

    // The delivery reserved a slot for the prompt it expected to start; a `handled` prompt must release it.
    const second = accept(system, '3', 't3', 'B')
    await until(() => logRecords(log).some(record => record.command === 'prompt' && record.message?.includes('"title":"B"')), 'the second ticket launch')
    expect(system.launches.filter(launch => launch.ticketId === second)).toHaveLength(1)
  })

  it('stops a turn that never settles and reports it failed', async () => {
    const system = createSystem(':memory:', {
      env: () => ({ FAKE_PI_HANG: '1' }),
      turnTimeoutMs: 100,
    })
    const ticketId = accept(system)

    await until(
      () => system.repo.tickets.get(ticketId)!.assignments[0]?.report?.state === 'failed',
      'the timeout report',
    )
    const report = system.repo.tickets.get(ticketId)!.assignments[0]!.report!
    expect(report.summary).toContain('执行超时')
    expect(report.summary).toContain('超过 1 分钟')
  })

  it('does not stop a long turn that keeps producing steps: the watchdog measures silence', async () => {
    const system = createSystem(':memory:', {
      env: () => ({ FAKE_PI_HANG: '1', FAKE_PI_BUSY_MS: '30' }),
      turnTimeoutMs: 150,
    })
    const ticketId = accept(system)
    await until(() => !!running(system, ticketId), 'the assignment to run')
    // Well past the watchdog: a total-length timer would have fired several times by now.
    await new Promise(resolve => setTimeout(resolve, 600))
    expect(system.repo.tickets.get(ticketId)!.assignments[0]?.report).toBeUndefined()
  })

  it('clears the watchdog when the turn settles in time', async () => {
    const directory = tempDir()
    const log = join(directory, 'pi.log')
    const system = createSystem(':memory:', {
      env: () => ({ FAKE_PI_LOG: log, FAKE_PI_RUN_MS: '20' }),
      turnTimeoutMs: 120,
    })
    const ticketId = accept(system)

    await until(() => !!running(system, ticketId)?.idleAt, 'the turn to settle')
    // Longer than the watchdog: a timer left armed would now report the settled ticket failed.
    await new Promise(resolve => setTimeout(resolve, 300))
    expect(system.repo.tickets.get(ticketId)!.assignments[0]?.report).toBeUndefined()
  })

  for (const state of ['waiting', 'blocked'] as const) {
    it(`exits an idle worker after a ${state} report settles and resumes its Session for a new Input`, async () => {
      const directory = tempDir()
      const log = join(directory, 'pi.log')
      const exits = join(directory, 'exit.log')
      const script = join(directory, 'idle-pi.mjs')
      writeFileSync(script, IDLE_PI)
      const system = createSystem(':memory:', {
        script,
        maxSlots: 1,
        env: () => ({ FAKE_PI_LOG: log, FAKE_PI_EXIT_LOG: exits }),
      })
      const ticketId = accept(system, '1', 't1', 'A')

      await until(() => !!running(system, ticketId), 'the assignment to run')
      await until(() => logRecords(log).some(record => record.command === 'prompt'), 'the assignment prompt')
      system.engine.report(ticketId, { state, summary: state })

      // Settled with nothing left to do: the process closes instead of holding its slot and memory.
      await until(() => exitRecords(exits).length === 1, 'the idle process to exit')
      const assignment = system.repo.tickets.get(ticketId)!.assignments[0]!
      expect(assignment.report?.state).toBe(state)
      expect(assignment.report?.state).not.toBe('failed')

      // The slot is free: another ticket launches while the first is still open.
      const second = accept(system, '3', 't2', 'B')
      await until(
        () => logRecords(log).some(record => record.command === 'prompt' && record.message?.includes('"title":"B"')),
        'the second ticket launch',
      )
      expect(system.launches.filter(launch => launch.ticketId === second)).toHaveLength(1)

      // A new Input wakes the retired worker with `--continue`, so it can recall the earlier Session.
      system.engine.receive(trigger('2', { actor: guest }))
      await until(() => logRecords(log).filter(record => record.command === 'prompt').length >= 3, 'a prompt on the resumed worker')
      const resumed = system.launches.filter(launch => launch.ticketId === ticketId)
      expect(resumed).toHaveLength(2)
      expect(resumed[0]!.resume).toBe(false)
      expect(resumed[1]!.resume).toBe(true)
    })
  }

  it('does not exit an idle worker after a progress report', async () => {
    const directory = tempDir()
    const log = join(directory, 'pi.log')
    const exits = join(directory, 'exit.log')
    const script = join(directory, 'idle-pi.mjs')
    writeFileSync(script, IDLE_PI)
    const system = createSystem(':memory:', {
      script,
      maxSlots: 1,
      env: () => ({ FAKE_PI_LOG: log, FAKE_PI_EXIT_LOG: exits }),
    })
    const ticketId = accept(system)

    await until(() => !!running(system, ticketId), 'the assignment to run')
    await until(() => logRecords(log).some(record => record.command === 'prompt'), 'the assignment prompt')
    system.engine.report(ticketId, { state: 'progress', summary: 'working' })
    await until(() => !!running(system, ticketId)?.idleAt, 'the turn to settle')

    // Longer than a retirement close would take: a progress report keeps the worker alive for the next turn.
    await new Promise(resolve => setTimeout(resolve, 200))
    expect(exitRecords(exits)).toHaveLength(0)
    expect(system.launches).toHaveLength(1)
    expect(system.repo.tickets.get(ticketId)!.assignments[0]!.report?.state).toBe('progress')
  })

  it('exits normally when a ready report ends the ticket', async () => {
    const directory = tempDir()
    const exits = join(directory, 'exit.log')
    const script = join(directory, 'idle-pi.mjs')
    writeFileSync(script, IDLE_PI)
    const system = createSystem(':memory:', { script, env: () => ({ FAKE_PI_EXIT_LOG: exits }) })
    const ticketId = accept(system)

    await until(() => !!running(system, ticketId), 'the assignment to run')
    system.engine.report(ticketId, { state: 'ready', summary: 'done' })

    await until(() => system.repo.tickets.get(ticketId)!.ended !== undefined, 'the ticket to end')
    await until(() => exitRecords(exits).length === 1, 'the process to exit')
    expect(system.repo.tickets.get(ticketId)!.ended).toMatchObject({ outcome: 'completed' })
    expect(system.repo.tickets.get(ticketId)!.assignments[0]!.report?.state).toBe('ready')
  })

  it('stops retrying a failing delivery after six attempts and keeps the failure visible', async () => {
    const directory = tempDir()
    const log = join(directory, 'pi.log')
    const script = join(directory, 'failing-delivery-pi.mjs')
    writeFileSync(script, FAILING_DELIVERY_PI)
    let clock = Date.parse('2026-09-23T00:00:00Z')
    const system = createSystem(':memory:', {
      script,
      now: () => clock,
      env: () => ({ FAKE_PI_LOG: log }),
    })
    const ticketId = accept(system)

    await until(() => !!running(system, ticketId)?.idleAt, 'the first turn to settle')
    system.engine.receive(trigger('2', { actor: guest }))

    const deliveryRow = (): { attempts: number; due: number; error: string } | undefined => system.repo.db
      .prepare("SELECT attempts, due, error FROM effects WHERE kind = 'delivery' AND item_key = ?")
      .get(ticketId) as { attempts: number; due: number; error: string } | undefined

    await until(() => Number(deliveryRow()?.attempts ?? 0) >= 1, 'the first failed delivery')
    // Advance the injected clock to each backoff deadline until the row reaches the cap.
    for (let attempt = 1; attempt < 6; attempt += 1) {
      clock = Math.max(clock, Number(deliveryRow()!.due))
      await system.effects.idle('delivery')
      await until(() => Number(deliveryRow()?.attempts ?? 0) > attempt, `delivery attempt ${attempt + 1}`)
    }

    const row = deliveryRow()!
    expect(row.attempts).toBe(6)
    expect(row.error).toContain('delivery refused')
    expect(system.effects.failures('delivery')).toMatchObject([
      { key: ticketId, attempts: 6, error: expect.stringContaining('delivery refused') },
    ])
    expect(system.repo.tickets.get(ticketId)!.delivery?.error).toContain('delivery refused')
    const attempts = (): number => logRecords(log)
      .filter(record => record.command === 'prompt' && record.message?.includes('message 2')).length
    expect(attempts()).toBe(6)

    // No clock value ever makes the exhausted row run a seventh time.
    clock += 1_000_000
    await new Promise(resolve => setTimeout(resolve, 50))
    await system.effects.idle('delivery')
    expect(deliveryRow()!.attempts).toBe(6)
    expect(attempts()).toBe(6)
  })
})
