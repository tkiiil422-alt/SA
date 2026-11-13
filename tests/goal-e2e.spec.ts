/**
 * Ticket goals through the real runtime with the fake Pi: the goal reaches the worker (system prompt, MCP timeout), a
 * ready report is held back while the acceptance command fails, the ticket stops at the round cap to ask a person,
 * and after the person's reply it ends once the command passes. Also the settings and goal routes.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { parseConfig } from '../src/config.ts'
import { createRuntime, type Runtime } from '../src/runtime.ts'

const FAKE_PI = fileURLToPath(new URL('./fixtures/fake-pi.mjs', import.meta.url))
process.env.SA_BACKUP_DIR = mkdtempSync(join(tmpdir(), 'superagent-goal-backups-'))
const WORKSPACES = mkdtempSync(join(tmpdir(), 'superagent-goal-ws-'))
process.env.SA_WORKSPACE_ROOT = WORKSPACES

const runtimes: Runtime[] = []
const dirs: string[] = []
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) { try { await runtime.stop() } catch { /* stopped */ } }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
const tempDir = (): string => { const dir = mkdtempSync(join(tmpdir(), 'superagent-goal-')); dirs.push(dir); return dir }

function apiFor(runtime: Runtime) {
  const token = readFileSync(join(runtime.stateDir, 'cli-token'), 'utf8').trim()
  return async (path: string, init: { method?: string; body?: unknown } = {}): Promise<{ status: number; json: any; text: string }> => {
    const response = await fetch(`${runtime.adminUrl}/api${path}`, {
      method: init.method ?? 'GET',
      headers: { authorization: `Bearer ${token}`, ...(init.body === undefined ? {} : { 'content-type': 'application/json', 'x-sa-request': '1' }) },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    })
    const text = await response.text()
    let json: unknown
    try { json = JSON.parse(text) } catch { json = undefined }
    return { status: response.status, json, text }
  }
}

async function waitFor<T>(read: () => Promise<T | undefined> | T | undefined, ms = 20_000): Promise<T> {
  const deadline = Date.now() + ms
  for (;;) {
    const value = await read()
    if (value !== undefined) return value
    if (Date.now() > deadline) throw new Error('timed out waiting')
    await new Promise(resolve => setTimeout(resolve, 100))
  }
}

const CHECK = 'node -e "process.exit(require(\'fs\').existsSync(\'done.txt\') ? 0 : 1)"'

describe('ticket goals through the runtime', () => {
  it('keeps a ticket going until its goal is met, stopping at the cap to ask a person', async () => {
    const envLog = join(tempDir(), 'launches.jsonl')
    const runtime = await createRuntime(parseConfig({
      stateDir: tempDir(), maxSlots: 2, operatorId: 'operator',
      launcher: { command: process.execPath, args: [FAKE_PI], env: { FAKE_PI_REPORT_READY: '1', FAKE_PI_RUN_MS: '20', FAKE_PI_ENV_LOG: envLog } },
      policy: { policy: { sources: { cli: { allowed: [{ id: 'operator', name: 'Operator' }] } } }, eval: { mode: 'auto' } },
    }))
    runtimes.push(runtime)
    const api = apiFor(runtime)

    // Settings: defaults, and a judge model that does not exist is refused.
    const settings = await api('/settings/goal')
    expect(settings.json).toEqual({ maxRounds: 8, maxUsd: 3, maxHours: 6, commandTimeoutSec: 600, judge: null })
    const badJudge = await api('/settings/goal', { method: 'PUT', body: { ...settings.json, judge: { provider: 'nope', model: 'x' } } })
    expect(badJudge.status).toBe(400)
    expect(badJudge.json.issues?.[0]?.path).toBe('judge')

    // A command mode without commands is a 400 on the goal field.
    const bad = await api('/tickets', { method: 'POST', body: { text: '写个 hello.py', goal: { text: '能跑', mode: 'commands' } } })
    expect(bad.status).toBe(400)
    expect(bad.json.issues?.[0]?.path).toBe('goal.commands')

    const created = await api('/tickets', {
      method: 'POST',
      body: { text: '写个 hello.py', goal: { text: '工作区里要有 done.txt', commands: [CHECK], mode: 'commands', maxRounds: 3 } },
    })
    expect(created.status, created.text).toBe(200)
    const id: string = created.json.ticketId

    // The worker hears about the goal at launch, and its MCP calls may take long enough for a check.
    const launch = await waitFor(() => existsSync(envLog)
      ? readFileSync(envLog, 'utf8').trim().split('\n').map(line => JSON.parse(line)).find(item => item.dir.endsWith(id))
      : undefined)
    const at = launch.args.indexOf('--append-system-prompt')
    expect(at).toBeGreaterThan(-1)
    expect(launch.args[at + 1]).toContain('工作区里要有 done.txt')
    const mcp = JSON.parse(readFileSync(join(runtime.stateDir, 'pi-config', id, 'mcp.json'), 'utf8'))
    expect(mcp.mcpServers.superagent.timeout).toBe(3600)

    // The worker keeps reporting ready while done.txt is missing: held back, pushed on, then stopped at the cap.
    const blocked = await waitFor(async () => {
      const d = (await api(`/tickets/${id}`)).json
      return d?.needsPerson && d.attention?.question?.includes('目标还没达成') ? d : undefined
    }, 30_000)
    expect(blocked.status).toBe('open')
    expect(blocked.goal).toMatchObject({ status: 'paused', roundCap: 3 })
    expect(blocked.goal.rounds).toBeGreaterThanOrEqual(3)
    expect(blocked.goal.last.commands[0]).toMatchObject({ code: 1 })
    const steps = (await api(`/tickets/${id}/activity?limit=200`)).json.items as { kind: string; summary: string }[]
    expect(steps.some(step => step.kind === 'goal' && step.summary.startsWith('目标检查：没通过'))).toBe(true)
    expect(steps.some(step => step.kind === 'goal' && step.summary.includes('停下等你'))).toBe(true)

    // The person fixes the missing piece and says go on: the next report is checked again and the ticket ends.
    mkdirSync(join(WORKSPACES, id), { recursive: true })
    writeFileSync(join(WORKSPACES, id, 'done.txt'), 'ok')
    const reply = await api(`/tickets/${id}/reply`, { method: 'POST', body: { text: '继续' } })
    expect(reply.status, reply.text).toBe(200)
    const done = await waitFor(async () => {
      const d = (await api(`/tickets/${id}`)).json
      return d?.status === 'ended' ? d : undefined
    }, 30_000)
    expect(done.outcome).toBe('completed')
    expect(done.goal).toMatchObject({ status: 'met' })
    expect(done.goal.roundCap).toBeGreaterThan(3)

    // Goal routes: a met goal cannot be cancelled, an ended ticket cannot take a new one.
    expect((await api(`/tickets/${id}/goal`)).json.goal).toMatchObject({ status: 'met' })
    expect((await api(`/tickets/${id}/goal`, { method: 'DELETE' })).json).toEqual({ ok: false })
    expect((await api(`/tickets/${id}/goal`, { method: 'PUT', body: { text: '再来' } })).status).toBe(400)
    expect((await api('/tickets/nope/goal')).status).toBe(404)

    // A ticket without a goal ends as before.
    const plain = await api('/tickets', { method: 'POST', body: { text: '再写个 world.py' } })
    const plainDone = await waitFor(async () => {
      const d = (await api(`/tickets/${plain.json.ticketId}`)).json
      return d?.status === 'ended' ? d : undefined
    })
    expect(plainDone.goal).toBeUndefined()
  }, 90_000)
})
