/** The new UI is served at /next/ beside the old one, and its API paths and step stream work through the real runtime. */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { parseConfig } from '../src/config.ts'
import { createRuntime, type Runtime } from '../src/runtime.ts'

const FAKE_PI = fileURLToPath(new URL('./fixtures/fake-pi.mjs', import.meta.url))
process.env.SA_BACKUP_DIR = mkdtempSync(join(tmpdir(), 'superagent-webnext-backups-'))
const runtimes: Runtime[] = []
const dirs: string[] = []
afterEach(async () => {
  for (const r of runtimes.splice(0)) { try { await r.stop() } catch { /* stopped */ } }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('new web UI mount', () => {
  it('serves /next/ and the legacy UI side by side, and the step stream answers', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'superagent-webnext-'))
    dirs.push(stateDir)
    const runtime = await createRuntime(parseConfig({
      stateDir, maxSlots: 2, operatorId: 'operator',
      launcher: { command: process.execPath, args: [FAKE_PI], env: { FAKE_PI_REPORT_READY: '1', FAKE_PI_RUN_MS: '20' } },
      policy: { policy: { sources: { cli: { allowed: [{ id: 'operator', name: 'Operator' }] } } }, eval: { mode: 'auto' } },
    }))
    runtimes.push(runtime)
    const base = runtime.adminUrl
    // New console is the default at /, the old one stays at /legacy/, /next/ redirects to the root.
    const root = await fetch(`${base}/`, { headers: { 'accept-encoding': 'gzip' } })
    expect(root.status).toBe(200)
    const html = await root.text()
    expect(html).toContain('id="root"')
    const asset = /src="\.\/(assets\/[^"]+\.js)"/.exec(html)?.[1]
    expect(asset).toBeDefined()
    expect((await fetch(`${base}/${asset}`)).status).toBe(200)
    expect((await fetch(`${base}/next/${asset}`)).status).toBe(200)
    expect((await fetch(`${base}/next/`, { redirect: 'manual' })).status).toBe(302)
    expect((await fetch(`${base}/legacy`, { redirect: 'manual' })).status).toBe(302)
    const legacy = await fetch(`${base}/legacy/`)
    expect(legacy.status).toBe(200)
    expect(await legacy.text()).toContain('app.js')
    expect((await fetch(`${base}/legacy/app.js`)).status).toBe(200)
    expect((await fetch(`${base}/legacy/../state.sqlite`)).status).toBe(404)
    expect((await fetch(`${base}/legacy/api/me`)).status).toBe(401)
    const token = readFileSync(join(stateDir, 'cli-token'), 'utf8').trim()
    const auth = { authorization: `Bearer ${token}` }
    const created = await fetch(`${base}/api/tickets`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json', 'x-sa-request': '1' }, body: JSON.stringify({ text: '写个 hello.py' }) })
    expect(created.status).toBe(200)
    const { ticketId } = await created.json() as { ticketId: string }
    const overview = await fetch(`${base}/legacy/api/overview`, { headers: auth })
    expect(overview.status).toBe(200)
    const ctl = new AbortController()
    const stream = await fetch(`${base}/api/tickets/${ticketId}/activity/stream`, { headers: auth, signal: ctl.signal })
    expect(stream.status).toBe(200)
    expect(stream.headers.get('content-type')).toContain('text/event-stream')
    const reader = stream.body!.getReader()
    const first = new TextDecoder().decode((await reader.read()).value)
    expect(first).toContain('retry:')
    ctl.abort()
  }, 20_000)
})
