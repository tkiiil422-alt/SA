/**
 * The real `AdminHost` against the real SQLite repositories, Engine, ledger, events, options and outbox.
 *
 * The executor and assessor are fakes, so nothing starts a process or touches the network; podman is injected through
 * `deps.run`. Tickets are created through the same `CliSource -> Engine` path the runtime's `ask` uses.
 */
import { existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Engine, threadKey } from '../src/core/index.ts'
import type { Assessor, Candidate, Executor, Thread, Ticket, Trigger } from '../src/core/index.ts'
import { CliSource } from '../src/sources/cli.ts'
import { SqliteRepositories } from '../src/store/sqlite.ts'
import { Effects } from '../src/effects/effects.ts'
import { Outbox } from '../src/outbox/outbox.ts'
import { Ledger } from '../src/ledger/ledger.ts'
import { EventLog } from '../src/ledger/events.ts'
import { ModelChoices } from '../src/ledger/choices.ts'
import { OptionsStore, defaultOptions } from '../src/admin/options.ts'
import { Vault } from '../src/admin/vault.ts'
import { settingsPolicy } from '../src/policy.ts'
import { defaultSettings } from '../src/config.ts'
import type { Settings } from '../src/policy.ts'
import { createRuntimeAdminHost, type RuntimeAdminDeps } from '../src/admin/runtime-host.ts'
import { AdminError } from '../src/admin/host.ts'
import type { AdminHost, CreateTicketResult } from '../src/admin/host.ts'

const DAY_MS = 24 * 60 * 60 * 1000

const dirs: string[] = []
const repos: SqliteRepositories[] = []

afterEach(() => {
  for (const repo of repos.splice(0)) {
    try {
      repo.close()
    } catch {
      // Already closed by the test.
    }
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sa-runtime-host-'))
  dirs.push(dir)
  return dir
}

/** Whether this machine lets the test create a directory link (Windows often needs Developer Mode for symlinks). */
const canSymlink = (() => {
  const base = mkdtempSync(join(tmpdir(), 'sa-symlink-check-'))
  try {
    mkdirSync(join(base, 'target'))
    symlinkSync(join(base, 'target'), join(base, 'link'), process.platform === 'win32' ? 'junction' : 'dir')
    return true
  } catch {
    return false
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})()

function harness() {
  const stateDir = tempDir()
  const workspaceRoot = join(stateDir, 'work')
  const piConfigRoot = join(stateDir, 'pi-config')
  mkdirSync(workspaceRoot, { recursive: true })
  mkdirSync(piConfigRoot, { recursive: true })

  const repo = new SqliteRepositories(':memory:')
  repos.push(repo)
  const effects = new Effects(repo.db)
  const outbox = new Outbox({ db: repo.db, effects })
  const ledger = new Ledger(repo.db)
  const events = new EventLog(repo.db)
  const options = new OptionsStore(join(stateDir, 'options.json'), defaultOptions({}))
  const vault = new Vault(join(stateDir, 'vault.json'), { env: {} })
  const source = new CliSource({ operatorId: 'operator' })
  let current: Settings = defaultSettings('operator')
  const settings = {
    get: (): Settings => current,
    set: (next: Settings): void => { current = next },
  }

  const clock = { now: new Date() }
  const requests: Candidate[] = []
  const assessor: Assessor = { request: candidate => { requests.push(candidate) }, release: () => {} }
  const launches: { ticketId: string; assignmentId: string }[] = []
  const executor: Executor = {
    start: (ticket, assignment) => { launches.push({ ticketId: ticket.id, assignmentId: assignment.id }) },
    deliver: () => {},
    stop: () => {},
  }
  const engine = new Engine({
    repo,
    scope: source,
    policy: () => settingsPolicy(current, source),
    assessor,
    executor,
    outbox,
    now: () => clock.now.toISOString(),
  })

  /** `sa ask` as the runtime does it, with a fake assessor that accepts every request at once. */
  const ask = async (text: string, _model?: string): Promise<CreateTicketResult> => {
    const trigger = source.ask(text)
    if (engine.receive(trigger) === 'stored') engine.evaluateDue()
    const candidate = requests.at(-1)
    if (candidate) {
      engine.decide(candidate.triggers[0]!.id, {
        kind: 'accept',
        title: text,
        scope: 'small',
        reason: 'requested',
        acknowledgement: '收到，开始处理。',
        rules: ['copy'],
        evalId: candidate.evalId,
      })
    }
    const decisionId = repo.triggers.disposition(trigger.id)?.decisionId
    const decision = decisionId === undefined ? undefined : repo.decisions.get(decisionId)
    const ref = trigger.threads[0]!
    return {
      triggerId: trigger.id,
      threadId: ref.id,
      threadKey: threadKey(ref),
      ...(decision?.ticketId === undefined ? {} : { ticketId: decision.ticketId }),
      ...(decision === undefined ? {} : { decision: decision.kind }),
    }
  }

  const replies: { id: string; text: string }[] = []
  let replyFailure: Error | undefined
  const reply = (id: string, text: string): void => {
    if (replyFailure) throw replyFailure
    replies.push({ id, text })
  }

  const runs: { file: string; args: string[]; timeout: number }[] = []
  let podman: (file: string, args: string[], timeout: number) => Promise<string> = async () => ''

  const deps: RuntimeAdminDeps = {
    repo,
    engine,
    outbox,
    ledger,
    events,
    options,
    vault,
    settings,
    source,
    ask,
    reply,
    slots: () => ({ used: 1, max: 2 }),
    // Derived from the fake clock, not the wall clock: otherwise a millisecond of drift makes uptime 59 seconds.
    startedAt: new Date(clock.now.getTime() - 60_000),
    version: '0.1.0',
    stateDir,
    workspaceRoot,
    piConfigRoot,
    backupDir: join(stateDir, 'backups'),
    configPath: join(stateDir, 'config.json'),
    gatewayUrl: 'http://127.0.0.1:1',
    mcpUrl: 'http://127.0.0.1:2/mcp',
    modelTest: async () => ({ ok: true, status: 200, latencyMs: 12, message: "连接正常" }),
    discoverModels: async () => ({ ok: true, message: '找到 0 个模型。', models: [] }),
    ticketModel: () => ({ ref: "default/deepseek-v4.1-flash", label: "deepseek-v4.1-flash", providerName: "默认服务", source: "default" as const }),
    now: () => clock.now,
    run: (file, args, timeout) => {
      runs.push({ file, args, timeout })
      return podman(file, args, timeout)
    },
  }
  const host = createRuntimeAdminHost(deps)

  return {
    host,
    repo,
    engine,
    ledger,
    events,
    effects,
    outbox,
    options,
    vault,
    source,
    settings,
    clock,
    workspaceRoot,
    piConfigRoot,
    stateDir,
    replies,
    launches,
    runs,
    setReplyFailure: (error: Error | undefined) => { replyFailure = error },
    setPodman: (fn: (file: string, args: string[], timeout: number) => Promise<string>) => { podman = fn },
  }
}

type Harness = ReturnType<typeof harness>

async function create(host: AdminHost, title = '修一个错别字'): Promise<string> {
  const result = await host.createTicket(title)
  expect(result.ticketId, `ask(${title}) created a ticket`).toBeDefined()
  return result.ticketId!
}

/** A person's later message on an existing thread, which the subscribed ticket receives as an Input. */
function followup(h: Harness, threadId: string, text: string): Trigger {
  const at = h.clock.now.toISOString()
  const trigger: Trigger = {
    id: `follow-${h.repo.tickets.list().length}-${h.clock.now.getTime()}`,
    source: 'cli',
    threads: [{ source: 'cli', id: threadId }],
    actor: { source: 'cli', id: 'operator' },
    human: true,
    at,
    text,
    channel: { source: 'cli', thread: threadId, address: { thread: threadId } },
    meta: {},
  }
  h.engine.receive(trigger)
  return trigger
}

function expectAdminError(work: () => unknown, status: number, message?: RegExp): AdminError {
  let caught: unknown
  try {
    work()
  } catch (error) {
    caught = error
  }
  expect(caught).toBeInstanceOf(AdminError)
  const error = caught as AdminError
  expect(error.status).toBe(status)
  if (message) expect(error.message).toMatch(message)
  return error
}

describe('runtime admin host', () => {
  it('creates a ticket and returns list rows and the detail shape', async () => {
    const h = harness()
    const result = await h.host.createTicket('修一个错别字')
    const id = result.ticketId!
    expect(result.triggerId).toBeTypeOf('string')
    expect(result.threadKey).toBe(`cli:${result.threadId}`)
    expect(result.decision).toBe('accept')

    h.ledger.record({
      at: new Date().toISOString(),
      ticketId: id,
      model: 'deepseek-v4.1-flash',
      status: 200,
      promptHit: 30,
      promptMiss: 70,
      completion: 5,
      costUsd: 0.25,
      latencyMs: 100,
    })

    const list = h.host.listTickets({ status: 'all', limit: 10, offset: 0 })
    expect(list.total).toBe(1)
    const row = list.items[0]!
    expect(row).toMatchObject({ id, title: '修一个错别字', status: 'open', needsPerson: false, costUsd: 0.25 })
    expect(row.createdAt).toBeTypeOf('string')
    expect(row.updatedAt).toBeTypeOf('string')
    expect(row.stage).toMatchObject({ stage: 'working', action: 'queued' })
    expect(row).not.toHaveProperty('question')

    // Search matches title or id, and pagination slices the sorted result.
    const byTitle = h.host.listTickets({ status: 'all', q: '错别', limit: 10, offset: 0 })
    expect(byTitle.items.map(item => item.id)).toEqual([id])
    const byId = h.host.listTickets({ status: 'all', q: id.slice(0, 8), limit: 10, offset: 0 })
    expect(byId.items.map(item => item.id)).toEqual([id])
    expect(h.host.listTickets({ status: 'all', limit: 0, offset: 0 }).items).toEqual([])
    expect(h.host.listTickets({ status: 'ended', limit: 10, offset: 0 }).total).toBe(0)

    const detail = h.host.ticket(id)!
    expect(detail).toMatchObject({ id, title: '修一个错别字', status: 'open' })
    expect(detail.mandate).toMatchObject({ strength: 'explicit', actor: { source: 'cli', id: 'operator' }, scope: 'small' })
    expect(detail.assignments).toHaveLength(1)
    expect(detail.assignments[0]).toMatchObject({ state: 'pending' })
    expect(detail.reports).toEqual([])
    // The origin trigger is not an Input; a later message on the thread is.
    expect(detail.inputs).toEqual([])
    expect(detail.messages).toEqual([
      expect.objectContaining({ kind: 'acknowledgement', text: '收到，开始处理。', status: 'pending' }),
    ])
    expect(detail.workspace).toEqual({ path: join(h.workspaceRoot, id), exists: false, fileCount: 0 })
    expect(detail.canRetry).toBe(false)
    expect(h.host.ticket('missing')).toBeUndefined()

    const trigger = followup(h, result.threadId, '再补充一句')
    const refreshed = h.host.ticket(id)!
    expect(refreshed.inputs).toHaveLength(1)
    expect(refreshed.inputs[0]).toMatchObject({ kind: 'trigger', human: true, text: '再补充一句', triggerId: trigger.id })
  })

  it('returns sorted summaries and pages them by updatedAt', async () => {
    const h = harness()
    const first = await create(h.host, '第一件事')
    h.clock.now = new Date(h.clock.now.getTime() + 1_000)
    const second = await create(h.host, '第二件事')
    const list = h.host.listTickets({ status: 'all', limit: 10, offset: 0 })
    expect(list.items.map(item => item.id)).toEqual([second, first])
    expect(h.host.listTickets({ status: 'all', limit: 1, offset: 1 }).items.map(item => item.id)).toEqual([first])
  })

  it('returns a clean title for a legacy ticket whose stored title is a Markdown brief', async () => {
    const h = harness()
    const id = await create(h.host, '整理 Q1 销售数据')
    // Simulates an old row: the stored title is the first 60 characters of a Markdown brief, as the old titleOf wrote it.
    h.repo.tickets.save({ ...h.repo.tickets.get(id)!, title: '# 旧标题\n\n## 目标\n\n产出一份报告' })

    const list = h.host.listTickets({ status: 'all', limit: 10, offset: 0 })
    expect(list.items.find(item => item.id === id)?.title).toBe('旧标题')
    expect(h.host.ticket(id)?.title).toBe('旧标题')
  })

  it('stops, retries and notes, mapping domain errors to AdminError', async () => {
    const h = harness()
    const id = await create(h.host)

    h.host.noteTicket(id, '补充背景')
    expect(h.repo.tickets.get(id)!.inputs.some(input => input.kind === 'note' && input.text === '补充背景')).toBe(true)

    h.engine.report(id, { state: 'failed', summary: 'broke' })
    const before = h.repo.tickets.get(id)!.assignments.length
    h.host.retryTicket(id)
    expect(h.repo.tickets.get(id)!.assignments).toHaveLength(before + 1)

    // A working ticket takes the instruction as its own Input, never through its thread (where Eval could open a new ticket).
    const ticketsBefore = h.repo.tickets.list().length
    h.host.replyTicket(id, '按原文保留')
    expect(h.replies).toEqual([])
    expect(h.repo.tickets.list()).toHaveLength(ticketsBefore)
    expect(h.repo.tickets.get(id)!.inputs.some(input => input.kind === 'text' && input.text.includes('按原文保留'))).toBe(true)
    expectAdminError(() => h.host.replyTicket('missing', 'x'), 404)

    h.host.stopTicket(id, '方向不对')
    expect(h.repo.tickets.get(id)!.ended).toMatchObject({ by: 'human', outcome: 'stopped', reason: '方向不对' })

    expectAdminError(() => h.host.stopTicket('missing'), 404)
    expectAdminError(() => h.host.retryTicket('missing'), 404)
    expectAdminError(() => h.host.noteTicket('missing', 'x'), 404)
    expectAdminError(() => h.host.noteTicket(id, 'x'), 409)
    expectAdminError(() => h.host.retryTicket(id), 409, /不能重试/)

    // A stopped ticket reopens on a new instruction written on it, in the same ticket, without going through its thread.
    const stoppedWith = h.repo.tickets.get(id)!.assignments.length
    h.host.replyTicket(id, '换个方向接着做')
    const reopened = h.repo.tickets.get(id)!
    expect(reopened.ended).toBeUndefined()
    expect(reopened.assignments).toHaveLength(stoppedWith + 1)
    expect(reopened.inputs.some(input => input.kind === 'text' && input.text.includes('换个方向接着做'))).toBe(true)
    expect(h.replies).toEqual([])

    // Back at work, the next instruction stays on this ticket too; the thread is never used, so its failure does not matter.
    h.setReplyFailure(new Error('这张票没有可回复的线程'))
    h.host.replyTicket(id, '再补一句')
    expect(h.repo.tickets.get(id)!.inputs.some(input => input.kind === 'text' && input.text.includes('再补一句'))).toBe(true)
  })

  it('clears the question card at once when a person answers a waiting ticket with an instruction', async () => {
    const h = harness()
    const id = await create(h.host)
    h.engine.report(id, { state: 'waiting', summary: '缺域名', question: '预览域名是什么？' })
    expect(h.repo.tickets.get(id)!.attention?.question).toBe('预览域名是什么？')
    h.host.replyTicket(id, 'http://175.178.18.140:18081/sa')
    const ticket = h.repo.tickets.get(id)!
    expect(ticket.attention).toBeUndefined()
    expect(ticket.inputs.some(input => input.kind === 'text' && input.text.includes('175.178.18.140'))).toBe(true)
    expect(h.replies).toEqual([])
  })

  it('continues a failed or timed-out ticket on a new instruction instead of routing it elsewhere', async () => {
    const h = harness()
    const id = await create(h.host)
    h.engine.report(id, { state: 'failed', summary: '执行超时，已被强制停止' })
    const before = h.repo.tickets.get(id)!.assignments.length
    h.host.replyTicket(id, '接着把截图测试跑完')
    const ticket = h.repo.tickets.get(id)!
    expect(h.replies).toEqual([])
    expect(ticket.ended).toBeUndefined()
    expect(ticket.assignments).toHaveLength(before + 1)
    expect(ticket.assignments.at(-2)!.state).toBe('ended')
    expect(ticket.undelivered.length).toBeGreaterThan(0)
  })

  it('reopens a completed ticket on a new instruction', async () => {
    const h = harness()
    const id = await create(h.host)
    h.engine.report(id, { state: 'ready', summary: '做完了' })
    expect(h.repo.tickets.get(id)!.ended).toMatchObject({ outcome: 'completed' })
    h.host.replyTicket(id, '再加一个导出视频的步骤')
    const ticket = h.repo.tickets.get(id)!
    expect(ticket.ended).toBeUndefined()
    expect(ticket.assignments.at(-1)!.state).not.toBe('ended')
  })

  it('filters tickets that wait on a person and exposes the question', async () => {
    const h = harness()
    const waiting = await create(h.host, '需要确认方向')
    const other = await create(h.host, '不用确认')
    h.engine.report(waiting, { state: 'blocked', summary: '卡住了', question: '要继续吗？' })

    const needs = h.host.listTickets({ status: 'needs-person', limit: 10, offset: 0 })
    expect(needs.total).toBe(1)
    expect(needs.items.map(item => item.id)).toEqual([waiting])
    expect(needs.items[0]).toMatchObject({ needsPerson: true, question: '要继续吗？' })

    const open = h.host.listTickets({ status: 'open', limit: 10, offset: 0 })
    expect(open.items.map(item => item.id).sort()).toEqual([waiting, other].sort())

    const detail = h.host.ticket(waiting)!
    expect(detail.attention).toMatchObject({ question: '要继续吗？' })
    expect(detail.reports.at(-1)).toMatchObject({ state: 'blocked', question: '要继续吗？' })
    // A report with a question raises attention, which `ticketStage` ranks above the blocked report itself.
    expect(detail.stage).toMatchObject({ stage: 'person', action: 'answer' })
    expect(detail.canRetry).toBe(true)

    const overview = h.host.overview()
    expect(overview.tickets.needsPerson).toBe(1)
    expect(overview.attentionTickets).toEqual([{ id: waiting, title: '需要确认方向', kind: 'blocked' }])
    expect(overview.slots).toEqual({ used: 1, max: 2, reservedForPerson: 1 })
    expect(overview.acceptMode).toBe('auto')
  })

  it('applies policy writes only when something changed and notifies the engine on version changes', async () => {
    const h = harness()
    const id = await create(h.host, '要判断的任务')
    const base = h.host.getPolicy()
    expect(base.acceptMode).toBe('auto')
    expect(base.allowedOperators).toEqual([{ id: 'operator', name: 'operator' }])

    // No change at all: nothing is persisted or queued.
    expect(h.host.updatePolicy(base)).toEqual({ changed: [] })

    // A timeout-only change persists but leaves the policy version alone, so no policy-changed input appears.
    const timed = { ...base, evalTimeoutSeconds: base.evalTimeoutSeconds + 1 }
    expect(h.host.updatePolicy(timed).changed).toEqual(['evalTimeoutSeconds'])
    expect(h.host.getPolicy().evalTimeoutSeconds).toBe(timed.evalTimeoutSeconds)
    expect(h.repo.tickets.get(id)!.inputs.filter(input => input.kind === 'policy-changed')).toHaveLength(0)

    // Disabling a rule the ticket was accepted under changes the version and produces an effect for the open ticket.
    const rules = h.host.getPolicy().rules.map(rule => rule.id === 'copy' ? { ...rule, enabled: false } : rule)
    expect(h.host.updatePolicy({ ...h.host.getPolicy(), rules }).changed).toEqual(['rules'])
    const inputs = h.repo.tickets.get(id)!.inputs.filter(input => input.kind === 'policy-changed')
    expect(inputs).toHaveLength(1)
    expect(inputs[0]).toMatchObject({ kind: 'policy-changed', effect: { rules: [{ id: 'copy', change: 'disabled' }] } })

    // Another version-neutral change does not call policyChanged again.
    h.host.updatePolicy({ ...h.host.getPolicy(), evalTimeoutSeconds: h.host.getPolicy().evalTimeoutSeconds + 1 })
    expect(h.repo.tickets.get(id)!.inputs.filter(input => input.kind === 'policy-changed')).toHaveLength(1)

    // The CLI source must keep at least one allowed operator.
    expectAdminError(() => h.host.updatePolicy({ ...h.host.getPolicy(), allowedOperators: [] }), 400, /至少要保留/)

    // Pause goes through the same persisted settings path.
    expect(h.host.setPaused(true)).toEqual({ paused: true, changed: true })
    expect(h.settings.get().paused).toBe(true)
    expect(h.host.setPaused(true)).toEqual({ paused: true, changed: false })
    expect(h.host.getPolicy().paused).toBe(true)
  })

  it('previews and deletes only old ended ticket directories, refusing unsafe ids', async () => {
    const h = harness()
    const ended = await create(h.host, '旧任务')
    const open = await create(h.host, '新任务')
    h.host.stopTicket(ended)

    mkdirSync(join(h.workspaceRoot, ended), { recursive: true })
    writeFileSync(join(h.workspaceRoot, ended, 'result.txt'), 'x'.repeat(1_000))
    mkdirSync(join(h.piConfigRoot, ended), { recursive: true })
    writeFileSync(join(h.piConfigRoot, ended, 'models.json'), '{}')
    mkdirSync(join(h.workspaceRoot, open), { recursive: true })
    writeFileSync(join(h.workspaceRoot, open, 'active.txt'), 'active')

    // A stored ticket id that would leave the roots must be ignored, not resolved.
    h.repo.tickets.save({ ...h.repo.tickets.get(ended)!, id: '../escape' })
    mkdirSync(join(h.stateDir, 'escape'), { recursive: true })
    writeFileSync(join(h.stateDir, 'escape', 'secret.txt'), 'SECRET')

    h.clock.now = new Date(h.clock.now.getTime() + 5 * DAY_MS)

    const preview = await h.host.cleanup({ olderThanDays: 3, dryRun: true })
    expect(preview.dryRun).toBe(true)
    expect(preview.deleted).toEqual([])
    expect(preview.freedBytes).toBe(0)
    expect(preview.entries.map(entry => entry.ticketId)).toEqual([ended])
    const entry = preview.entries[0]!
    expect(entry.title).toBe('旧任务')
    expect(entry.ageDays).toBe(5)
    expect(entry.workspacePath).toBe(join(h.workspaceRoot, ended))
    expect(entry.piConfigPath).toBe(join(h.piConfigRoot, ended))
    expect(entry.bytes).toBeGreaterThanOrEqual(1_000)
    expect(existsSync(join(h.workspaceRoot, ended))).toBe(true)

    const performed = await h.host.cleanup({ olderThanDays: 3, dryRun: false })
    expect(performed.deleted).toEqual([ended])
    expect(performed.freedBytes).toBeGreaterThanOrEqual(1_000)
    expect(existsSync(join(h.workspaceRoot, ended))).toBe(false)
    expect(existsSync(join(h.piConfigRoot, ended))).toBe(false)
    expect(existsSync(join(h.workspaceRoot, open, 'active.txt'))).toBe(true)
    expect(existsSync(join(h.stateDir, 'escape', 'secret.txt'))).toBe(true)
  })

  it.skipIf(!canSymlink)('unlinks a symlinked ticket directory without following it', async () => {
    const h = harness()
    const id = await create(h.host, '链接任务')
    h.host.stopTicket(id)
    const outside = join(h.stateDir, 'outside')
    mkdirSync(outside, { recursive: true })
    writeFileSync(join(outside, 'secret.txt'), 'SECRET')
    symlinkSync(outside, join(h.workspaceRoot, id), process.platform === 'win32' ? 'junction' : 'dir')

    h.clock.now = new Date(h.clock.now.getTime() + 5 * DAY_MS)
    const result = await h.host.cleanup({ olderThanDays: 3, dryRun: false })

    expect(result.deleted).toContain(id)
    expect(() => lstatSync(join(h.workspaceRoot, id))).toThrow()
    expect(existsSync(join(outside, 'secret.txt'))).toBe(true)
  })

  it('reads containers and disk usage, and degrades softly when podman fails', async () => {
    const h = harness()
    const id = await create(h.host, '容器任务')
    mkdirSync(join(h.workspaceRoot, id), { recursive: true })
    writeFileSync(join(h.workspaceRoot, id, 'file.txt'), 'x'.repeat(2_048))
    mkdirSync(join(h.piConfigRoot, id), { recursive: true })
    writeFileSync(join(h.piConfigRoot, id, 'models.json'), '{}')
    writeFileSync(join(h.stateDir, 'state.sqlite'), 'x'.repeat(4_096))

    h.setPodman(async () => `sa-${id}\tUp 2 minutes\nunrelated\tExited (0)\n`)
    const system = await h.host.system()
    expect(h.runs[0]).toMatchObject({ file: 'podman', args: ['ps', '--format', '{{.Names}}\t{{.Status}}'] })
    expect(h.runs[0]!.timeout).toBeGreaterThan(0)
    expect(system.containers).toEqual([{ name: `sa-${id}`, ticketId: id, status: 'Up 2 minutes', runningFor: '' }])
    expect(system.limits.maxWorkers).toBe(2)
    expect(system.disk.workspacesMb).toBeGreaterThan(0)
    expect(system.disk.piConfigMb).toBeGreaterThan(0)
    expect(system.disk.dbMb).toBeGreaterThan(0)
    expect(system.disk.freeGb).toBeGreaterThanOrEqual(0)
    expect(system.warning).toBeUndefined()

    h.setPodman(async () => { throw new Error('podman: command not found') })
    const failed = await h.host.system()
    expect(failed.containers).toEqual([])
    expect(failed.warning).toContain('podman')
  })

  it('returns decisions newest first with trigger text and raw reasons', async () => {
    const h = harness()
    const make = (suffix: string, iso: string, text: string): void => {
      const triggerId = `tr-${suffix}`
      const threadId = `th-${suffix}`
      const key = `cli:${threadId}`
      h.repo.triggers.save({
        id: triggerId,
        source: 'cli',
        threads: [{ source: 'cli', id: threadId }],
        actor: { source: 'cli', id: 'operator' },
        human: true,
        at: iso,
        text,
        meta: {},
      })
      h.repo.threads.save({ key, ref: { source: 'cli', id: threadId }, createdAt: iso, subscriptions: [], correlated: [], pending: [], meta: {} })
      h.repo.decisions.save({
        id: `d-${suffix}`,
        evalId: `e-${suffix}`,
        threadKey: key,
        triggerIds: [triggerId],
        policyVersion: 'v1',
        at: iso,
        kind: 'accept',
        reason: [{ code: 'explicitRouted' }],
        strength: 'explicit',
        ticketId: `t-${suffix}`,
      })
    }
    make('old', new Date('2026-01-01T00:00:00Z').toISOString(), '旧的决定')
    make('new', new Date('2026-02-01T00:00:00Z').toISOString(), '新'.repeat(300))

    const items = h.host.decisions(10)
    expect(items.map(item => item.id)).toEqual(['d-new', 'd-old'])
    expect(items[0]!.triggerText).toHaveLength(200)
    expect(items[0]!.reasons).toEqual([{ code: 'explicitRouted' }])
    expect(items[0]!.ticketId).toBe('t-new')
    expect(items[1]!.triggerText).toBe('旧的决定')
    expect(h.host.decisions(1)).toHaveLength(1)
  })

  it('confines workspace roots to known tickets with safe ids and maps titles', async () => {
    const h = harness()
    const id = await create(h.host, '路径任务')
    expect(h.host.workspaceRoot(id)).toBe(join(h.workspaceRoot, id))
    expect(h.host.workspaceRoot('missing')).toBeUndefined()
    expect(h.host.workspaceRoot('../escape')).toBeUndefined()
    expect(h.host.ticketTitles([id, 'missing'])).toEqual({ [id]: '路径任务' })
  })

  it('reports process facts and caches the upstream probe for the overview', async () => {
    const h = harness()
    const info = h.host.info()
    expect(info).toMatchObject({
      version: '0.1.0',
      node: process.version,
      platform: process.platform,
      stateDir: h.stateDir,
      configPath: join(h.stateDir, 'config.json'),
      gatewayUrl: 'http://127.0.0.1:1',
      mcpUrl: 'http://127.0.0.1:2/mcp',
    })
    expect(info.uptimeSec).toBeGreaterThanOrEqual(60)
    expect(info.startedAt).toBeTypeOf('string')

    expect(h.host.overview().upstream).toMatchObject({ ok: true, model: 'deepseek-v4.1-flash' })
    const result = await h.host.modelTest("default", "deepseek-v4.1-flash")
    expect(result).toEqual({ ok: true, status: 200, latencyMs: 12, message: '连接正常' })
    expect(h.host.overview().upstream.checkedAt).toBeDefined()
    expect(h.host.overview().host.cpuCount).toBeGreaterThan(0)
  })

  it('rejects a policy write that the settings schema refuses', async () => {
    const h = harness()
    // The API validates first in practice; the host still guards direct callers.
    expect(() => h.host.updatePolicy({ ...h.host.getPolicy(), acceptMode: 'sometimes' as never })).toThrowError(AdminError)
  })
})

describe('ticket deletion, orphans and backups', () => {
  it('deletes an ended ticket with its dependent rows and directories but keeps the usage ledger', async () => {
    const h = harness()
    const id = await create(h.host, '要删除的任务')
    const ticket = h.repo.tickets.get(id)!

    mkdirSync(join(h.workspaceRoot, id), { recursive: true })
    writeFileSync(join(h.workspaceRoot, id, 'a.txt'), 'x'.repeat(100))
    mkdirSync(join(h.piConfigRoot, id), { recursive: true })
    writeFileSync(join(h.piConfigRoot, id, 'models.json'), '{}')

    h.outbox.send({
      id: 'message-delete', channel: { source: 'cli', thread: 'cli:thread', address: {} },
      text: 'hi', kind: 'reply', ticketId: id,
    })
    const choices = new ModelChoices(h.repo.db)
    choices.set(ticket.origin.triggerId, { provider: 'default', model: 'm', source: 'person' })
    const ref = h.repo.triggers.get(ticket.origin.triggerId)!.threads[0]!
    const key = `${ref.source}:${ref.id}`
    const thread: Thread = h.repo.threads.get(key)
      ?? { key, ref, createdAt: h.clock.now.toISOString(), subscriptions: [], correlated: [], pending: [], meta: {} }
    thread.subscriptions.push(id)
    h.repo.threads.save(thread)
    h.ledger.record({
      at: h.clock.now.toISOString(), ticketId: id, model: 'm', status: 200,
      promptHit: 0, promptMiss: 0, completion: 0, costUsd: 0.25, latencyMs: 1,
    })

    h.host.stopTicket(id)
    const result = h.host.deleteTicket(id, { deleteWorkspace: true, force: false })

    expect(result.ok).toBe(true)
    expect(result.freedBytes).toBeGreaterThan(0)
    expect(h.repo.tickets.get(id)).toBeUndefined()
    expect(existsSync(join(h.workspaceRoot, id))).toBe(false)
    expect(existsSync(join(h.piConfigRoot, id))).toBe(false)
    expect(h.outbox.messagesForTicket(id)).toEqual([])
    expect(h.effects.pending('reply', 'message-delete')).toBe(false)
    expect(choices.get(ticket.origin.triggerId)).toBeUndefined()
    expect(h.repo.threads.get(thread.key)!.subscriptions).not.toContain(id)
    // Billing history and audit stay.
    expect(h.ledger.calls({ ticketId: id })).toHaveLength(1)
    expect(h.events.list({ ticketId: id }).some(event => event.kind === 'ticket.deleted')).toBe(true)
  })

  it('grants existing secrets at creation and drops grants when the ticket is deleted', async () => {
    const h = harness()
    h.vault.create('API_TOKEN', 'super-secret-value', '', 'operator')

    const id = (await h.host.createTicket('带密钥的任务', undefined, ['API_TOKEN'])).ticketId!
    expect(h.host.ticket(id)?.secrets).toEqual(['API_TOKEN'])
    expect(h.host.ticketSecrets(id)).toEqual(['API_TOKEN'])

    h.host.stopTicket(id)
    h.host.deleteTicket(id, { deleteWorkspace: true, force: false })

    expect(h.vault.grants(id)).toEqual([])
    expect(h.vault.has('API_TOKEN')).toBe(true)
  })

  it('refuses to create a ticket with an unknown secret name', async () => {
    const h = harness()
    await expect(h.host.createTicket('任务', undefined, ['NOPE'])).rejects.toMatchObject({ status: 400 })
  })

  it('refuses an open ticket without force and deletes it with force', async () => {
    const h = harness()
    const id = await create(h.host, '正在运行的任务')

    expectAdminError(() => h.host.deleteTicket(id, { deleteWorkspace: true, force: false }), 409, /进行/)
    expect(h.repo.tickets.get(id)).toBeDefined()

    h.host.deleteTicket(id, { deleteWorkspace: true, force: true })
    expect(h.repo.tickets.get(id)).toBeUndefined()
  })

  it('rejects an unsafe ticket id and reports each batch skip', async () => {
    const h = harness()
    const ended = await create(h.host, '已结束的')
    h.host.stopTicket(ended)
    const open = await create(h.host, '还开着的')

    expectAdminError(() => h.host.deleteTicket('../escape', { deleteWorkspace: true, force: false }), 400)

    const result = h.host.deleteTickets([ended, 'missing', 'bad/id', open], { deleteWorkspace: true, force: false })
    expect(result.deleted).toEqual([ended])
    expect(result.skipped).toEqual([
      { id: 'missing', reason: 'not_found' },
      { id: 'bad/id', reason: 'invalid_path' },
      { id: open, reason: 'running' },
    ])
    expect(h.repo.tickets.get(open)).toBeDefined()
  })

  it('lists and removes orphan directories but leaves directories that still have a ticket', async () => {
    const h = harness()
    const keep = await create(h.host, '保留的任务')
    mkdirSync(join(h.workspaceRoot, keep), { recursive: true })
    writeFileSync(join(h.workspaceRoot, keep, 'keep.txt'), 'keep')
    mkdirSync(join(h.workspaceRoot, 'orphan-w'), { recursive: true })
    writeFileSync(join(h.workspaceRoot, 'orphan-w', 'a.txt'), 'x'.repeat(50))
    mkdirSync(join(h.piConfigRoot, 'orphan-p'), { recursive: true })
    writeFileSync(join(h.piConfigRoot, 'orphan-p', 'models.json'), '{}')

    const listed = h.host.orphans()
    expect(listed.items.map(item => `${item.kind}:${item.id}`)).toEqual(['pi-config:orphan-p', 'workspace:orphan-w'])
    expect(listed.totalBytes).toBeGreaterThan(0)

    const cleanup = h.host.cleanupOrphans(['orphan-w', 'orphan-p', keep])
    expect(cleanup.deleted.sort()).toEqual(['orphan-p', 'orphan-w'])
    expect(cleanup.freedBytes).toBeGreaterThan(0)
    expect(existsSync(join(h.workspaceRoot, keep))).toBe(true)
    expect(h.host.orphans().items).toEqual([])
  })

  it('writes and lists a state backup through the host', async () => {
    const h = harness()
    const created = await h.host.createBackup()
    expect(created.ok).toBe(true)
    expect(created.item.name).toMatch(/^state-\d{8}-\d{6}\.tgz$/)
    const listed = h.host.backups()
    expect(listed.dir).toBe(join(h.stateDir, 'backups'))
    expect(listed.items.map(item => item.name)).toEqual([created.item.name])
  })
})
