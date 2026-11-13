/**
 * Multi-model collaboration through the real runtime, with the fake Pi kept running: the settings route, the extension
 * and role table written into a ticket's Pi config, a per-ticket opt-out, sub-agent tokens at the gateway (booked per
 * role, own upstream session) and their refusal at the worker MCP endpoint. A local stub stands in for the upstream.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { parseConfig } from '../src/config.ts'
import { createRuntime, type Runtime } from '../src/runtime.ts'

const FAKE_PI = fileURLToPath(new URL('./fixtures/fake-pi.mjs', import.meta.url))
const EXTENSION = fileURLToPath(new URL('../deploy/pi-ext/collab.ts', import.meta.url))
process.env.SA_BACKUP_DIR = mkdtempSync(join(tmpdir(), 'superagent-collab-backups-'))

const runtimes: Runtime[] = []
const servers: Server[] = []
const dirs: string[] = []
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) { try { await runtime.stop() } catch { /* stopped */ } }
  for (const server of servers.splice(0)) await new Promise<void>(resolve => server.close(() => resolve()))
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
const tempDir = (): string => { const dir = mkdtempSync(join(tmpdir(), 'superagent-collab-')); dirs.push(dir); return dir }

async function stubUpstream(): Promise<{ url: string; calls: { headers: IncomingHttpHeaders; model: string }[] }> {
  const calls: { headers: IncomingHttpHeaders; model: string }[] = []
  const server = createServer((req, res) => {
    const parts: Buffer[] = []
    req.on('data', chunk => parts.push(chunk as Buffer))
    req.on('end', () => {
      let model = ''
      try { model = String(JSON.parse(Buffer.concat(parts).toString('utf8')).model ?? '') } catch { /* not json */ }
      calls.push({ headers: req.headers, model })
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        id: 'x', object: 'chat.completion', created: 0, model,
        choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 10 },
      }))
    })
  })
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, calls }
}

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

interface LaunchEnv { token: string; mcp: string; gateway: string; dir: string; image: string }
const launches = (file: string): LaunchEnv[] =>
  existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as LaunchEnv) : []
async function waitFor<T>(read: () => T | undefined, ms = 10_000): Promise<T> {
  const deadline = Date.now() + ms
  for (;;) {
    const value = read()
    if (value !== undefined) return value
    if (Date.now() > deadline) throw new Error('timed out waiting')
    await new Promise(resolve => setTimeout(resolve, 50))
  }
}

describe('collaboration through the runtime', () => {
  it('equips a ticket with helpers, books their calls per role and keeps them off the MCP endpoint', async () => {
    const envLog = join(tempDir(), 'launches.jsonl')
    const runtime = await createRuntime(parseConfig({
      stateDir: tempDir(), maxSlots: 2, operatorId: 'operator',
      launcher: { command: process.execPath, args: [FAKE_PI], env: { FAKE_PI_HANG: '1', FAKE_PI_ENV_LOG: envLog } },
      policy: { policy: { sources: { cli: { allowed: [{ id: 'operator', name: 'Operator' }] } } }, eval: { mode: 'auto' } },
    }))
    runtimes.push(runtime)
    const api = apiFor(runtime)
    const upstream = await stubUpstream()
    const price = { input: 0.3, cacheRead: 0.006, output: 1.2 }
    const models = await api('/settings/models', {
      method: 'PUT',
      body: {
        providers: [{
          id: 'default', name: '默认服务', api: 'openai-completions', baseUrl: `${upstream.url}/v1`, sessionHeader: 'x-opencode-session',
          enabled: true, models: [{ id: 'deepseek-v4.1-flash', price }, { id: 'glm-5.3-flash', price }],
        }],
        routing: {
          worker: { provider: 'default', model: 'deepseek-v4.1-flash' },
          assessor: { enabled: false, provider: 'default', model: 'deepseek-v4.1-flash', timeoutSec: 30 },
          autoSelect: false,
        },
      },
    })
    expect(models.status, models.text).toBe(200)

    // Settings: on by default with five roles; a role on a missing model is refused field by field.
    const current = await api('/settings/collab')
    expect(current.status).toBe(200)
    expect(current.json).toMatchObject({ enabled: true, maxConcurrent: 2, maxCalls: 20 })
    const roles: { id: string }[] = current.json.roles
    expect(roles.map(role => role.id)).toEqual(['scout', 'planner', 'reviewer', 'advisor', 'helper'])
    const withScout = (model: { provider: string; model: string }) => roles.map((role, index) => index === 0 ? { ...role, model } : role)
    const bad = await api('/settings/collab', { method: 'PUT', body: { ...current.json, roles: withScout({ provider: 'default', model: 'missing' }) } })
    expect(bad.status).toBe(400)
    expect(bad.json.issues?.[0]?.path).toBe('roles.0.model')
    const saved = await api('/settings/collab', { method: 'PUT', body: { ...current.json, maxCalls: 7, roles: withScout({ provider: 'default', model: 'glm-5.3-flash' }) } })
    expect(saved.status, saved.text).toBe(200)

    // A new ticket gets the extension and the role table in its Pi config directory.
    const created = await api('/tickets', { method: 'POST', body: { text: '写个 hello.py' } })
    expect(created.status, created.text).toBe(200)
    const ticketId: string = created.json.ticketId
    const launch = await waitFor(() => launches(envLog).find(item => item.dir.endsWith(ticketId)))
    const piDir = join(runtime.stateDir, 'pi-config', ticketId)
    expect(readFileSync(join(piDir, 'extensions', 'sa-collab', 'index.ts'), 'utf8')).toBe(readFileSync(EXTENSION, 'utf8'))
    const table = JSON.parse(readFileSync(join(piDir, 'collab.json'), 'utf8'))
    expect(table).toMatchObject({ version: 1, mainModel: 'sa-default/deepseek-v4.1-flash', maxConcurrent: 2, maxCalls: 7, secretNames: [] })
    expect(Object.fromEntries(table.roles.map((role: { id: string; model: string }) => [role.id, role.model]))).toEqual({
      scout: 'sa-default/glm-5.3-flash', planner: 'sa-default/deepseek-v4.1-flash', reviewer: 'sa-default/deepseek-v4.1-flash',
      advisor: 'sa-default/deepseek-v4.1-flash', helper: 'sa-default/deepseek-v4.1-flash',
    })

    // Gateway: the suffixed token works on the same ticket, with its own upstream session, and is booked per role.
    const chat = async (token: string, model: string): Promise<number> => {
      const response = await fetch(`${runtime.gatewayUrl}/p/default/chat/completions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }] }),
      })
      await response.text()
      return response.status
    }
    expect(await chat(`${launch.token}.scout`, 'glm-5.3-flash')).toBe(200)
    expect(await chat(launch.token, 'deepseek-v4.1-flash')).toBe(200)
    expect(await chat(`${launch.token}.Not_A_Role`, 'glm-5.3-flash')).toBe(401)
    expect(await chat('unknown-token.scout', 'glm-5.3-flash')).toBe(401)
    expect(upstream.calls.map(item => [item.model, item.headers['x-opencode-session']])).toEqual([
      ['glm-5.3-flash', `${ticketId}-scout`],
      ['deepseek-v4.1-flash', ticketId],
    ])
    const detail = await api(`/tickets/${ticketId}`)
    expect(detail.status).toBe(200)
    expect(detail.json.byAgent.map((item: { agent: string; calls: number }) => [item.agent, item.calls])).toEqual([['', 1], ['scout', 1]])
    expect(detail.json.calls.find((item: { agent: string }) => item.agent === 'scout')?.model).toBe('glm-5.3-flash')

    // Worker MCP: the ticket token reaches it, a sub-agent's suffixed token never does.
    const mcp = async (token: string): Promise<number> => {
      const ctl = new AbortController()
      const response = await fetch(runtime.mcpUrl, {
        method: 'POST', signal: ctl.signal,
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
      })
      const status = response.status
      ctl.abort()
      return status
    }
    expect(await mcp(`${launch.token}.scout`)).toBe(401)
    expect(await mcp(launch.token)).not.toBe(401)

    // A ticket created with helpers switched off gets neither the extension nor the role table.
    const off = await api('/tickets', { method: 'POST', body: { text: '再写个 world.py', collab: false } })
    expect(off.status, off.text).toBe(200)
    const offId: string = off.json.ticketId
    await waitFor(() => launches(envLog).find(item => item.dir.endsWith(offId)))
    const offDir = join(runtime.stateDir, 'pi-config', offId)
    expect(existsSync(join(offDir, 'models.json'))).toBe(true)
    expect(existsSync(join(offDir, 'collab.json'))).toBe(false)
    expect(existsSync(join(offDir, 'extensions', 'sa-collab'))).toBe(false)
  }, 40_000)
})
