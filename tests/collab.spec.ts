/** Collaboration building blocks: the role table, sub-agent tokens, per-ticket opt-outs, per-role ledger rows, steps. */
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { OptionsSchema, defaultOptions } from '../src/admin/options.ts'
import { ActivityLog, delegationSummary } from '../src/executor/activity.ts'
import { CollabChoices, collabFile, defaultCollabRoles, splitAgentToken, type CollabRoleDefaults, type CollabSettings } from '../src/executor/collab.ts'
import { Ledger } from '../src/ledger/ledger.ts'

const role = (id: string, over: Partial<CollabRoleDefaults> = {}): CollabRoleDefaults => ({
  id, name: id, description: `${id} 的说明`, access: 'read', enabled: true, model: null, prompt: '', ...over,
})

describe('collaboration roles', () => {
  it('ships five roles that pass the options schema, switched on', () => {
    const roles = defaultCollabRoles()
    expect(roles.map(r => r.id)).toEqual(['scout', 'planner', 'reviewer', 'advisor', 'helper'])
    expect(Object.fromEntries(roles.map(r => [r.id, r.access]))).toEqual({ scout: 'read', planner: 'read', reviewer: 'shell', advisor: 'ask', helper: 'write' })
    expect(OptionsSchema.parse(defaultOptions({})).collab).toMatchObject({ enabled: true, maxConcurrent: 2, maxCalls: 20 })
  })

  it('refuses duplicate role ids and out-of-range limits', () => {
    const base = defaultOptions({}).collab
    expect(OptionsSchema.shape.collab.safeParse({ ...base, roles: [role('scout'), role('scout')] }).success).toBe(false)
    expect(OptionsSchema.shape.collab.safeParse({ ...base, maxConcurrent: 9 }).success).toBe(false)
    expect(OptionsSchema.shape.collab.safeParse({ ...base, roles: [role('Bad Id')] }).success).toBe(false)
  })

  it('builds collab.json: disabled roles dropped, unusable or unset models fall back to the ticket model', () => {
    const settings: CollabSettings = {
      enabled: true, maxConcurrent: 2, maxCalls: 9,
      roles: [
        role('scout', { model: { provider: 'p', model: 'cheap' } }),
        role('reviewer', { access: 'shell', model: { provider: 'gone', model: 'x' } }),
        role('advisor', { access: 'ask' }),
        role('helper', { access: 'write', enabled: false }),
      ],
    }
    const file = collabFile(settings, ref => ref.provider === 'p', { provider: 'main', model: 'm1' }, ['B', 'A', 'B'])
    expect(file).toMatchObject({ version: 1, mainModel: 'sa-main/m1', maxConcurrent: 2, maxCalls: 9, secretNames: ['A', 'B'] })
    expect(file.roles.map(r => [r.id, r.model, r.access])).toEqual([
      ['scout', 'sa-p/cheap', 'read'],
      ['reviewer', 'sa-main/m1', 'shell'],
      ['advisor', 'sa-main/m1', 'ask'],
    ])
  })

  it('splits a sub-agent token into the ticket token and its role', () => {
    expect(splitAgentToken('AbC_-123')).toEqual({ token: 'AbC_-123', agent: '' })
    expect(splitAgentToken('AbC_-123.scout')).toEqual({ token: 'AbC_-123', agent: 'scout' })
    expect(splitAgentToken('tok.role-2')).toEqual({ token: 'tok', agent: 'role-2' })
    for (const bad of ['tok.', 'tok.Scout', 'tok.a.b', 'tok.-x', `tok.${'a'.repeat(33)}`]) expect(splitAgentToken(bad), bad).toBeUndefined()
  })

  it('remembers tickets created with collaboration off', () => {
    const choices = new CollabChoices(new DatabaseSync(':memory:'))
    expect(choices.isOff('tr-1')).toBe(false)
    choices.setOff('tr-1')
    choices.setOff('tr-1')
    expect(choices.isOff('tr-1')).toBe(true)
    expect(choices.isOff('tr-2')).toBe(false)
  })
})

describe('ledger rows per sub-agent', () => {
  const row = (agent?: string, costUsd = 0.1) => ({
    at: new Date().toISOString(), ticketId: 't1', model: 'm', status: 200, promptHit: 0, promptMiss: 10, completion: 2, costUsd, latencyMs: 5,
    provider: 'p', ...(agent === undefined ? {} : { agent }),
  })

  it('books each call under its role and splits a ticket by role', () => {
    const ledger = new Ledger(new DatabaseSync(':memory:'))
    ledger.record(row())
    ledger.record(row('scout', 0.2))
    ledger.record(row('scout', 0.3))
    ledger.record(row('reviewer', 1))
    const split = ledger.ticketByAgent('t1')
    expect(split.map(item => [item.agent, item.calls])).toEqual([['', 1], ['reviewer', 1], ['scout', 2]])
    expect(split.find(item => item.agent === 'scout')?.usd).toBeCloseTo(0.5, 10)
    expect(ledger.ticketTotals('t1').usd).toBeCloseTo(1.6, 10)
    expect(ledger.calls({ ticketId: 't1' })[0]?.agent).toBe('reviewer')
  })

  it('adds the agent column to a table created before it existed', () => {
    const db = new DatabaseSync(':memory:')
    db.exec(`CREATE TABLE usage_calls (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, ticket_id TEXT NOT NULL, model TEXT NOT NULL,
      status INTEGER NOT NULL, prompt_hit INTEGER NOT NULL, prompt_miss INTEGER NOT NULL, completion INTEGER NOT NULL, cost_usd REAL NOT NULL,
      latency_ms INTEGER NOT NULL, provider TEXT NOT NULL DEFAULT '')`)
    db.prepare("INSERT INTO usage_calls (at, ticket_id, model, status, prompt_hit, prompt_miss, completion, cost_usd, latency_ms) VALUES (?, 't1', 'm', 200, 0, 0, 0, 0.5, 1)")
      .run(new Date().toISOString())
    const ledger = new Ledger(db)
    ledger.record(row('scout'))
    expect(ledger.ticketByAgent('t1').map(item => [item.agent, item.calls])).toEqual([['', 1], ['scout', 1]])
  })
})

describe('who made a step', () => {
  it('tags steps with the main model and a delegation with its sub-agents and their models', () => {
    const log = new ActivityLog()
    log.record('t1', { type: 'message_end', message: { role: 'assistant', model: 'deepseek-v4.1-flash', content: [{ type: 'text', text: '先派审查' }] } })
    log.record('t1', { type: 'tool_execution_start', toolCallId: 'c1', toolName: 'subagent', args: { tasks: [{ agent: 'scout', task: 'a' }, { agent: 'reviewer', task: 'b' }] } })
    const [say, call] = log.list('t1').items
    expect(say).toMatchObject({ kind: 'say', model: 'deepseek-v4.1-flash' })
    expect(call).toMatchObject({ model: 'deepseek-v4.1-flash', agents: [{ role: 'scout', name: '侦察', state: 'queued' }, { role: 'reviewer', name: '审查', state: 'queued' }] })
    log.record('t1', {
      type: 'tool_execution_update', toolCallId: 'c1', toolName: 'subagent',
      partialResult: { content: [{ type: 'text', text: '侦察：进行中；审查：排队，已 3 秒' }], details: { mode: 'parallel', agents: [
        { role: 'scout', name: '侦察', model: 'sa-default/glm-5.3-flash', state: 'running' },
        { role: 'reviewer', name: '审查', model: 'sa-gw/claude-opus-5-5', state: 'queued' },
      ] } },
    })
    expect(log.list('t1').items.at(-1)?.agents?.[0]).toMatchObject({ model: 'sa-default/glm-5.3-flash', state: 'running' })
    log.record('t1', {
      type: 'tool_execution_end', toolCallId: 'c1', toolName: 'subagent',
      result: { content: [{ type: 'text', text: 'ok' }], details: { results: [
        { role: 'scout', name: '侦察', model: 'sa-default/glm-5.3-flash', ok: true, turns: 2, ms: 900 },
        { role: 'reviewer', name: '审查', model: 'sa-gw/claude-opus-5-5', ok: false, turns: 1, ms: 400 },
      ] } },
    })
    expect(log.list('t1').items.at(-1)?.agents?.map(a => [a.role, a.state, a.ms])).toEqual([['scout', 'done', 900], ['reviewer', 'failed', 400]])
  })

  it('marks sub-agents stopped when the turn or the daemon ends under them, and keeps who made each step', () => {
    const db = new DatabaseSync(':memory:')
    const log = new ActivityLog(undefined, db)
    log.record('t1', { type: 'message_end', message: { role: 'assistant', model: 'm1', content: [{ type: 'text', text: 'x' }] } })
    log.record('t1', { type: 'tool_execution_start', toolCallId: 'c1', toolName: 'subagent', args: { agent: 'reviewer', task: 'b' } })
    log.record('t1', {
      type: 'tool_execution_update', toolCallId: 'c1', toolName: 'subagent',
      partialResult: { content: [{ type: 'text', text: '审查：进行中' }], details: { agents: [{ role: 'reviewer', name: '审查', model: 'sa-gw/claude-opus-5-5', state: 'running' }] } },
    })
    // A restart reads the same database into a fresh log.
    const again = new ActivityLog(undefined, db)
    expect(again.list('t1').items.find(item => item.tool === 'subagent')).toMatchObject({
      status: 'error', model: 'm1', agents: [{ role: 'reviewer', state: 'stopped', model: 'sa-gw/claude-opus-5-5' }],
    })
    expect(again.list('t1').items[0]).toMatchObject({ kind: 'say', model: 'm1' })
    log.record('t1', { type: 'agent_settled' })
    expect(log.list('t1').items.find(item => item.tool === 'subagent')?.agents?.[0]?.state).toBe('stopped')
  })

  it('adds the model and agents columns to a step table created before they existed', () => {
    const db = new DatabaseSync(':memory:')
    db.exec(`CREATE TABLE activity_steps (id INTEGER PRIMARY KEY, ticket_id TEXT NOT NULL, seq INTEGER NOT NULL, at TEXT NOT NULL, kind TEXT NOT NULL,
      tool TEXT, summary TEXT NOT NULL, detail TEXT, status TEXT NOT NULL, ms INTEGER)`)
    db.prepare("INSERT INTO activity_steps (id, ticket_id, seq, at, kind, summary, status) VALUES (1, 't1', 1, ?, 'turn', '旧步骤', 'done')").run(new Date().toISOString())
    const log = new ActivityLog(undefined, db)
    expect(log.list('t1').items).toMatchObject([{ summary: '旧步骤' }])
    log.record('t1', { type: 'message_end', message: { role: 'assistant', model: 'm2', content: [{ type: 'text', text: 'y' }] } })
    expect(new ActivityLog(undefined, db).list('t1').items.at(-1)).toMatchObject({ kind: 'say', model: 'm2' })
  })
})

describe('delegation steps', () => {
  it('summarises who was asked to do what', () => {
    expect(delegationSummary({ agent: 'reviewer', task: '看 src/gateway 的改动' })).toBe('审查：看 src/gateway 的改动')
    expect(delegationSummary({ tasks: [{ agent: 'scout', task: 'A' }, { agent: 'scout', task: 'B' }, { agent: 'planner', task: 'C' }] }))
      .toBe('并行 3 个：侦察、侦察、规划；A')
    expect(delegationSummary({ chain: [{ agent: 'scout', task: 'find X' }, { agent: 'reviewer', task: '{previous}' }] })).toBe('串联：侦察 → 审查；find X')
    expect(delegationSummary({ agent: 'custom-role', task: 'x' })).toBe('custom-role：x')
  })

  it('keeps a delegation step current while its sub-agents report progress', () => {
    const log = new ActivityLog()
    log.record('t1', { type: 'tool_execution_start', toolCallId: 'c1', toolName: 'subagent', args: { agent: 'reviewer', task: '看改动' } })
    const started = log.list('t1')
    expect(started.items[0]).toMatchObject({ tool: 'subagent', summary: '审查：看改动', status: 'running' })
    const update = { type: 'tool_execution_update', toolCallId: 'c1', toolName: 'subagent', partialResult: { content: [{ type: 'text', text: '审查：进行中（read），已 20 秒' }] } }
    log.record('t1', update)
    const moved = log.list('t1', started.last)
    expect(moved.items).toHaveLength(1)
    expect(moved.items[0]).toMatchObject({ id: started.items[0]!.id, detail: '审查：进行中（read），已 20 秒', status: 'running' })
    // The same note again is not a new step; progress of other tools is ignored.
    log.record('t1', update)
    log.record('t1', { type: 'tool_execution_start', toolCallId: 'c2', toolName: 'bash', args: { command: 'ls' } })
    const afterBash = log.list('t1', moved.last)
    log.record('t1', { type: 'tool_execution_update', toolCallId: 'c2', toolName: 'bash', partialResult: { content: [{ type: 'text', text: 'x' }] } })
    expect(log.list('t1', afterBash.last).items).toHaveLength(0)
    log.record('t1', { type: 'tool_execution_end', toolCallId: 'c1', toolName: 'subagent', result: { content: [{ type: 'text', text: '没发现问题' }] } })
    expect(log.list('t1').items.find(item => item.tool === 'subagent')).toMatchObject({ status: 'done', detail: '没发现问题' })
  })
})
