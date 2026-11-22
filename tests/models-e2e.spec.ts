/**
 * Multi-model wiring through the real runtime: the admin API's model list, a person's model choice on a new ticket,
 * and the 400 for a model that is disabled or unknown. Uses the fake Pi; nothing touches the network.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { parseConfig, type Config } from '../src/config.ts'
import { createRuntime, type Runtime } from '../src/runtime.ts'

const FAKE_PI = fileURLToPath(new URL('./fixtures/fake-pi.mjs', import.meta.url))

const runtimes: Runtime[] = []
const directories: string[] = []
/** Keep the daemon's startup backups inside the OS temp directory, never the operator's home. */
process.env.SA_BACKUP_DIR = mkdtempSync(join(tmpdir(), 'superagent-models-backups-'))

function tempDir(): string {
  const directory = mkdtempSync(join(tmpdir(), 'superagent-models-'))
  directories.push(directory)
  return directory
}

function configFor(stateDir: string): Config {
  return parseConfig({
    stateDir,
    maxSlots: 2,
    operatorId: 'operator',
    launcher: { command: process.execPath, args: [FAKE_PI], env: { FAKE_PI_REPORT_READY: '1', FAKE_PI_RUN_MS: '20' } },
    policy: {
      policy: { sources: { cli: { allowed: [{ id: 'operator', name: 'Operator' }] } } },
      eval: { mode: 'auto' },
    },
  })
}

afterEach(async () => {
  for (const runtime of runtimes.splice(0).reverse()) {
    try { await runtime.stop() } catch { /* already stopped */ }
  }
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

interface Api {
  (path: string, init?: { method?: string; body?: unknown }): Promise<{ status: number; json: any; text: string }>
}

function apiFor(runtime: Runtime): Api {
  const token = readFileSync(join(runtime.stateDir, 'cli-token'), 'utf8').trim()
  return async (path, init = {}) => {
    const response = await fetch(`${runtime.adminUrl}/api${path}`, {
      method: init.method ?? 'GET',
      headers: {
        authorization: `Bearer ${token}`,
        ...(init.body === undefined ? {} : { 'content-type': 'application/json', 'x-sa-request': '1' }),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    })
    const text = await response.text()
    let json: unknown
    try { json = JSON.parse(text) } catch { json = undefined }
    return { status: response.status, json, text }
  }
}

const routing = {
  worker: { provider: 'default', model: 'deepseek-v4.1-flash' },
  assessor: { enabled: false, provider: 'default', model: 'deepseek-v4.1-flash', timeoutSec: 30 },
  autoSelect: false,
}
const price = { input: 0.3, cacheRead: 0.006, output: 1.2 }
const providers = [
  {
    id: 'default', name: '默认服务', api: 'openai-completions', baseUrl: 'https://api.deepseek.com', sessionHeader: '',
    enabled: true,
    models: [
      { id: 'deepseek-v4.1-flash', label: 'Flash', price },
      { id: 'deepseek-v4-pro', label: 'Pro', description: '难题用它', price },
    ],
  },
  {
    id: 'claude', name: 'Anthropic', api: 'anthropic-messages', baseUrl: 'https://api.anthropic.com', sessionHeader: '',
    enabled: false,
    models: [{ id: 'claude-sonnet-5-5', price: { input: 3, cacheRead: 0.3, output: 15 } }],
  },
]

describe('multi-model wiring through the admin API', () => {
  it('lists only enabled models, stores a person choice, and refuses a disabled model', async () => {
    const runtime = await createRuntime(configFor(tempDir()))
    runtimes.push(runtime)
    const api = apiFor(runtime)

    const saved = await api('/settings/models', { method: 'PUT', body: { providers, routing } })
    expect(saved.status, saved.text).toBe(200)

    const listed = await api('/models')
    expect(listed.status).toBe(200)
    expect(listed.json.default).toBe('default/deepseek-v4.1-flash')
    const refs = listed.json.items.map((item: { ref: string }) => item.ref)
    expect(refs).toEqual(['default/deepseek-v4.1-flash', 'default/deepseek-v4-pro'])
    expect(refs).not.toContain('claude/claude-sonnet-5-5')

    // A model on a disabled provider, and a malformed ref, are both a 400 on the `model` field.
    for (const model of ['claude/claude-sonnet-5-5', 'no-slash', 'default/missing']) {
      const bad = await api('/tickets', { method: 'POST', body: { text: '写个 hello.py', model } })
      expect(bad.status, model).toBe(400)
      expect(bad.json.issues?.[0]?.path, model).toBe('model')
    }

    // A valid choice is recorded as the person's and shows on the ticket.
    const created = await api('/tickets', { method: 'POST', body: { text: '写个 hello.py', model: 'default/deepseek-v4-pro' } })
    expect(created.status, created.text).toBe(200)
    expect(created.json.ticketId).toBeDefined()
    const detail = await api(`/tickets/${created.json.ticketId}`)
    expect(detail.status).toBe(200)
    expect(detail.json.model).toMatchObject({ ref: 'default/deepseek-v4-pro', label: 'Pro', source: 'person' })

    // Without a choice the ticket runs on the default worker model.
    const plain = await api('/tickets', { method: 'POST', body: { text: '再写个 world.py' } })
    expect(plain.status, plain.text).toBe(200)
    const plainDetail = await api(`/tickets/${plain.json.ticketId}`)
    expect(plainDetail.json.model).toMatchObject({ ref: 'default/deepseek-v4.1-flash', source: 'default' })

    // The worker's Pi config lists only enabled providers, routed through the gateway with the ticket token as key.
    const piConfig = JSON.parse(readFileSync(join(runtime.stateDir, 'pi-config', created.json.ticketId, 'models.json'), 'utf8'))
    expect(Object.keys(piConfig.providers)).toEqual(['sa-default'])
    expect(piConfig.providers['sa-default'].baseUrl).toBe(`${runtime.gatewayUrl}/p/default`)
    expect(piConfig.providers['sa-default'].apiKey).toBe('${SA_TICKET_TOKEN}')
  }, 20_000)

  it('never sends a saved key to an edited address when fetching the model list', async () => {
    const runtime = await createRuntime(configFor(tempDir()))
    runtimes.push(runtime)
    const api = apiFor(runtime)
    const secret = 'sk-SAVED-KEY-1234567890'
    const withKey = providers.map(p => (p.id === 'default' ? { ...p, apiKey: secret } : p))
    expect((await api('/settings/models', { method: 'PUT', body: { providers: withKey, routing } })).status).toBe(200)

    // Same provider id, different host, no key typed: refused before any request leaves the daemon.
    const moved = await api('/settings/models/discover', {
      method: 'POST',
      body: { provider: 'default', api: 'openai-completions', baseUrl: 'http://127.0.0.1:9/elsewhere' },
    })
    expect(moved.status).toBe(200)
    expect(moved.json.ok).toBe(false)
    expect(moved.json.message).toContain('重新填写密钥')
    expect(moved.text).not.toContain(secret)

    // A changed protocol on the same address is refused the same way.
    const otherApi = await api('/settings/models/discover', {
      method: 'POST',
      body: { provider: 'default', api: 'anthropic-messages', baseUrl: 'https://api.deepseek.com' },
    })
    expect(otherApi.json.ok).toBe(false)
    expect(otherApi.json.message).toContain('重新填写密钥')
  }, 20_000)
})
