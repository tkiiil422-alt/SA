/**
 * The Pi collaboration extension (`deploy/pi-ext/collab.ts`) run outside Pi: its `subagent` tool spawns
 * `tests/fixtures/fake-pi-child.mjs` in place of `pi`, which logs the environment and arguments each child received.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import register, {
  childArgs, childEnv, createCollabTool, readConfig, takeCalls, toolDescription,
  type CollabConfig, type CollabRole, type SubagentParams, type ToolDefinition, type ToolResult,
} from '../deploy/pi-ext/collab.ts'

const CHILD = fileURLToPath(new URL('./fixtures/fake-pi-child.mjs', import.meta.url))
const ENV_KEYS = ['PI_CODING_AGENT_DIR', 'SA_COLLAB_PI_SCRIPT', 'FAKE_CHILD_LOG', 'SA_TICKET_TOKEN', 'SA_MCP_URL', 'SOME_SECRET', 'SA_AGENT', 'SA_COLLAB_CHECK']

const role = (id: string, access: CollabRole['access']): CollabRole => ({ id, name: id, description: `${id} 的说明`, access, model: `sa-x/${id}-model`, prompt: `${id} prompt` })
const config = (over: Partial<CollabConfig> = {}): CollabConfig => ({
  version: 1, mainModel: 'sa-x/main', maxConcurrent: 2, maxCalls: 20, secretNames: ['SOME_SECRET'],
  roles: [role('scout', 'read'), role('reviewer', 'shell'), role('advisor', 'ask'), role('helper', 'write')],
  ...over,
})

interface ChildRun { agent: string; token: string; mcp: string | null; secret: string | null; args: string[]; message: string; start: number; end: number }

let dir = ''
const saved: Record<string, string | undefined> = {}
const runs = (): ChildRun[] => {
  const file = join(dir, 'children.jsonl')
  return existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as ChildRun) : []
}
/** Most children alive at the same moment. */
const peak = (list: ChildRun[]): number => {
  const points = list.flatMap(r => [[r.start, 1], [r.end, -1]] as [number, number][]).sort((a, b) => a[0] - b[0] || a[1] - b[1])
  let now = 0
  let max = 0
  for (const [, delta] of points) { now += delta; max = Math.max(max, now) }
  return max
}
const tool = (c: CollabConfig = config()): ToolDefinition => {
  writeFileSync(join(dir, 'collab.json'), JSON.stringify(c))
  return createCollabTool(c)
}
const call = (t: ToolDefinition, params: SubagentParams, signal?: AbortSignal): Promise<ToolResult> => t.execute('call-1', params, signal, undefined, { cwd: dir })
const textOf = (r: ToolResult): string => r.content.map(part => part.text).join('\n')

beforeEach(() => {
  for (const key of ENV_KEYS) saved[key] = process.env[key]
  dir = mkdtempSync(join(tmpdir(), 'sa-collab-ext-'))
  process.env.PI_CODING_AGENT_DIR = dir
  process.env.SA_COLLAB_PI_SCRIPT = CHILD
  process.env.FAKE_CHILD_LOG = join(dir, 'children.jsonl')
  process.env.SA_TICKET_TOKEN = 'tok123'
  process.env.SA_MCP_URL = 'http://127.0.0.1:1/mcp'
  process.env.SOME_SECRET = 's3cret'
  delete process.env.SA_AGENT
  delete process.env.SA_COLLAB_CHECK
})
afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key]
    else process.env[key] = saved[key]
  }
  rmSync(dir, { recursive: true, force: true })
})

describe('collab extension helpers', () => {
  it('reads collab.json, dropping malformed roles and clamping limits', () => {
    writeFileSync(join(dir, 'collab.json'), JSON.stringify({
      roles: [{ id: 'a', name: 'A', access: 'read', model: 'm' }, { id: 'b', name: 'B', access: 'root', model: 'm' }, { id: 3 }],
      maxConcurrent: 99, maxCalls: 0,
    }))
    expect(readConfig(dir)).toMatchObject({ mainModel: '', maxConcurrent: 8, maxCalls: 20, secretNames: [], roles: [{ id: 'a', description: '', prompt: '' }] })
    expect(readConfig(dir)?.roles).toHaveLength(1)
    rmSync(join(dir, 'collab.json'))
    expect(readConfig(dir)).toBeUndefined()
  })

  it('starts children without MCP, extensions or project files, with tools by access, and the task after --', () => {
    const read = childArgs(role('scout', 'read'), '--model evil', '/tmp/p.md')
    for (const flag of ['--no-mcp', '--no-extensions', '--no-approve', '--no-session', '--offline']) expect(read).toContain(flag)
    expect(read.slice(read.indexOf('--tools'), read.indexOf('--tools') + 2)).toEqual(['--tools', 'read,grep,find,ls'])
    expect(read.slice(read.indexOf('--model'), read.indexOf('--model') + 2)).toEqual(['--model', 'sa-x/scout-model'])
    expect(read.slice(-2)).toEqual(['--', '任务：--model evil'])
    const ask = childArgs(role('advisor', 'ask'), 'q', undefined)
    expect(ask).toContain('--no-tools')
    expect(ask).not.toContain('--tools')
    expect(ask).not.toContain('--append-system-prompt')
    const write = childArgs(role('helper', 'write'), 'x', undefined)
    expect(write[write.indexOf('--tools') + 1]).toBe('read,grep,find,ls,bash,edit,write')
  })

  it('gives children a role-suffixed token, no MCP or previews, and secrets only when they may write', () => {
    const base = { SA_TICKET_TOKEN: 'tok', SA_MCP_URL: 'u', SA_PREVIEW_PORTS: '4000', SOME_SECRET: 's', PATH: 'p' }
    const scout = childEnv(base, role('scout', 'read'), config())
    expect(scout).toMatchObject({ SA_TICKET_TOKEN: 'tok.scout', SA_AGENT: 'scout', PATH: 'p' })
    expect(scout.SA_MCP_URL).toBeUndefined()
    expect(scout.SA_PREVIEW_PORTS).toBeUndefined()
    expect(scout.SOME_SECRET).toBeUndefined()
    expect(childEnv(base, role('helper', 'write'), config()).SOME_SECRET).toBe('s')
    expect(childEnv({ ...base, SA_TICKET_TOKEN: 'tok.other' }, role('helper', 'write'), config()).SA_TICKET_TOKEN).toBe('tok.helper')
  })

  it('describes every role and the limits to the main worker', () => {
    const text = toolDescription(config({ maxCalls: 7, maxConcurrent: 3 }))
    for (const id of ['scout', 'reviewer', 'advisor', 'helper']) expect(text).toContain(`- ${id}（`)
    expect(text).toContain('最多调用 7 次')
    expect(text).toContain('同时最多跑 3 个')
  })

  it('counts calls per ticket across calls', () => {
    expect(takeCalls(dir, 2, 3)).toEqual({ ok: true, used: 2 })
    expect(takeCalls(dir, 2, 3)).toEqual({ ok: false, used: 2 })
    expect(takeCalls(dir, 1, 3)).toEqual({ ok: true, used: 3 })
  })
})

describe('subagent tool', () => {
  it('runs one role and hands back its answer with who answered', async () => {
    const r = await call(tool(), { agent: 'scout', task: '找出网关重试' })
    expect(r.isError).toBeFalsy()
    expect(textOf(r)).toContain('【scout｜sa-x/scout-model｜1 轮')
    expect(textOf(r)).toContain('scout:任务：找出网关重试')
    const [child] = runs()
    expect(child).toMatchObject({ agent: 'scout', token: 'tok123.scout', mcp: null, secret: null })
    expect(child!.args).toContain('sa-x/scout-model')
  }, 20_000)

  it('runs parallel tasks at most maxConcurrent at a time', async () => {
    const r = await call(tool(), { tasks: ['A', 'B', 'C'].map(t => ({ agent: 'scout', task: `${t} SLEEP=600` })) })
    expect(textOf(r)).toContain('并行 3 个，成功 3 个')
    expect(runs()).toHaveLength(3)
    expect(peak(runs())).toBe(2)
  }, 20_000)

  it('runs roles that change files one at a time, and only they get the secrets', async () => {
    const r = await call(tool(config({ maxConcurrent: 4 })), {
      tasks: [{ agent: 'helper', task: 'a SLEEP=400' }, { agent: 'helper', task: 'b SLEEP=400' }, { agent: 'scout', task: 'c SLEEP=400' }],
    })
    expect(r.isError).toBeFalsy()
    const all = runs()
    expect(peak(all.filter(item => item.agent === 'helper'))).toBe(1)
    expect(all.filter(item => item.agent === 'helper').map(item => item.secret)).toEqual(['s3cret', 's3cret'])
    expect(all.find(item => item.agent === 'scout')?.secret).toBeNull()
  }, 20_000)

  it('chains roles, passing each answer on as {previous}', async () => {
    const r = await call(tool(), { chain: [{ agent: 'scout', task: 'A' }, { agent: 'reviewer', task: 'review: {previous}' }] })
    expect(r.isError).toBeFalsy()
    expect(runs().map(item => item.message)).toEqual(['任务：A', '任务：review: scout:任务：A'])
    expect(textOf(r)).toContain(' → ')
    expect(textOf(r)).toContain('reviewer:任务：review: scout:任务：A')
  }, 20_000)

  it('reports a failed child, stops a chain there, and says when the budget is spent', async () => {
    const t = tool()
    const failed = await call(t, { agent: 'scout', task: 'FAIL' })
    expect(failed.isError).toBe(true)
    expect(textOf(failed)).toContain('boom')
    const chain = await call(t, { chain: [{ agent: 'scout', task: 'FAIL' }, { agent: 'reviewer', task: '{previous}' }] })
    expect(textOf(chain)).toContain('串联在第 1 步')
    expect(runs().filter(item => item.agent === 'reviewer')).toHaveLength(0)
    const budget = await call(t, { agent: 'advisor', task: 'BUDGET' })
    expect(budget.isError).toBe(true)
    expect(textOf(budget)).toContain('预算已用完')
  }, 20_000)

  it('stops handing out work once the ticket used its calls', async () => {
    const t = tool(config({ maxCalls: 3 }))
    expect((await call(t, { tasks: [{ agent: 'scout', task: 'a' }, { agent: 'scout', task: 'b' }] })).isError).toBeFalsy()
    const over = await call(t, { tasks: [{ agent: 'scout', task: 'c' }, { agent: 'scout', task: 'd' }] })
    expect(over.isError).toBe(true)
    expect(textOf(over)).toContain('次数已用完')
    expect(runs()).toHaveLength(2)
  }, 20_000)

  it('refuses bad parameters before spawning or counting anything', async () => {
    const t = tool()
    expect(textOf(await call(t, { agent: 'ghost', task: 'x' }))).toContain('没有角色「ghost」')
    expect(textOf(await call(t, { agent: 'scout', task: '  ' }))).toContain('task 是空的')
    expect(textOf(await call(t, { agent: 'scout', task: 'x', tasks: [{ agent: 'scout', task: 'y' }] }))).toContain('参数不对')
    expect(textOf(await call(t, { tasks: Array.from({ length: 9 }, () => ({ agent: 'scout', task: 'x' })) }))).toContain('最多 8 个')
    expect(runs()).toHaveLength(0)
    expect(existsSync(join(dir, 'collab-usage.json'))).toBe(false)
  })

  it('stops a child when the main worker aborts', async () => {
    const ctl = new AbortController()
    const started = Date.now()
    setTimeout(() => ctl.abort(), 300)
    const r = await call(tool(), { agent: 'scout', task: 'SLEEP=8000' }, ctl.signal)
    expect(r.isError).toBe(true)
    expect(textOf(r)).toContain('已取消')
    expect(Date.now() - started).toBeLessThan(6000)
  }, 20_000)

  it('rereads the role table on every call', async () => {
    const t = tool()
    writeFileSync(join(dir, 'collab.json'), JSON.stringify(config({ roles: [role('advisor', 'ask')] })))
    expect(textOf(await call(t, { agent: 'scout', task: 'x' }))).toContain('没有角色「scout」')
  })
})

describe('progress details', () => {
  it('reports which sub-agent runs on which model while it works and when it ends', async () => {
    const updates: ToolResult[] = []
    const t = tool()
    const result = await t.execute('c', { tasks: [{ agent: 'scout', task: 'a SLEEP=300' }, { agent: 'advisor', task: 'b SLEEP=300' }] }, undefined, u => updates.push(u), { cwd: dir })
    const seen = updates.map(u => (u.details as { agents?: { role: string; model: string; state: string }[] } | undefined)?.agents).filter(list => list !== undefined)
    expect(seen.length).toBeGreaterThan(0)
    expect(seen.some(list => list!.some(a => a.role === 'scout' && a.model === 'sa-x/scout-model' && a.state === 'running'))).toBe(true)
    expect(seen.at(-1)!.map(a => a.state)).toEqual(['done', 'done'])
    const final = (result.details as { results: { role: string; model: string; ok: boolean }[] }).results
    expect(final.map(r => [r.role, r.model, r.ok])).toEqual([['scout', 'sa-x/scout-model', true], ['advisor', 'sa-x/advisor-model', true]])
  }, 20_000)
})

describe('register', () => {
  const registered = (): string[] => {
    const names: string[] = []
    register({ registerTool: definition => { names.push(definition.name) } })
    return names
  }

  it('registers the tool only for a main worker that has a role table', () => {
    expect(registered()).toEqual([])
    writeFileSync(join(dir, 'collab.json'), JSON.stringify(config()))
    expect(registered()).toEqual(['subagent'])
    process.env.SA_AGENT = 'scout'
    expect(registered()).toEqual([])
  })

  it('registers for the image check without a role table', () => {
    process.env.SA_COLLAB_CHECK = '1'
    expect(registered()).toEqual(['subagent'])
  })
})
