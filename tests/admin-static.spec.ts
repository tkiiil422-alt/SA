import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createAdminServer, type AdminServer } from '../src/admin/server.ts'
import { createStaticHandler } from '../src/admin/static.ts'

const dirs: string[] = []
const servers: AdminServer[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sa-static-'))
  dirs.push(dir)
  return dir
}

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

interface Fixture {
  root: string
  outside: string
  secret: string
}

function fixture(): Fixture {
  const base = tempDir()
  const root = join(base, 'root')
  const outside = join(base, 'outside')
  mkdirSync(join(root, 'sub'), { recursive: true })
  mkdirSync(outside, { recursive: true })
  writeFileSync(join(root, 'index.html'), '<!doctype html><title>后台</title>')
  writeFileSync(join(root, 'app.js'), 'console.log(1)')
  writeFileSync(join(root, 'style.css'), 'body{color:#000}')
  writeFileSync(join(root, 'data.json'), '{"ok":true}')
  writeFileSync(join(root, 'icon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"></svg>')
  writeFileSync(join(root, 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  writeFileSync(join(root, 'favicon.ico'), Buffer.from([0, 0, 1, 0, 1, 0]))
  writeFileSync(join(root, 'notes.txt'), 'hello')
  writeFileSync(join(outside, 'secret.txt'), 'TOP-SECRET-STATIC')
  return { root, outside, secret: 'TOP-SECRET-STATIC' }
}

async function start(root: string): Promise<string> {
  const server = createAdminServer({ api: async () => false, staticHandler: createStaticHandler(root), port: 0 })
  servers.push(server)
  const { port } = await server.listen()
  return `http://127.0.0.1:${port}`
}

describe('static handler', () => {
  it('serves index.html for / with the security headers and no-cache', async () => {
    const { root } = fixture()
    const base = await start(root)
    const response = await fetch(`${base}/`)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8')
    expect(response.headers.get('cache-control')).toBe('no-cache')
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    expect(response.headers.get('x-frame-options')).toBe('DENY')
    expect(response.headers.get('content-security-policy')).toBe("default-src 'self'; style-src 'self' 'unsafe-inline'")
    expect(await response.text()).toContain('<title>后台</title>')
  })

  it('serves JavaScript and CSS without caching, and other types with their MIME', async () => {
    const { root } = fixture()
    const base = await start(root)

    const js = await fetch(`${base}/app.js`)
    expect(js.headers.get('content-type')).toBe('text/javascript; charset=utf-8')
    expect(js.headers.get('cache-control')).toBe('no-cache')

    const css = await fetch(`${base}/style.css`)
    expect(css.headers.get('content-type')).toBe('text/css; charset=utf-8')
    expect(css.headers.get('cache-control')).toBe('no-cache')

    const json = await fetch(`${base}/data.json`)
    expect(json.headers.get('content-type')).toBe('application/json; charset=utf-8')

    const svg = await fetch(`${base}/icon.svg`)
    expect(svg.headers.get('content-type')).toBe('image/svg+xml')

    const png = await fetch(`${base}/logo.png`)
    expect(png.headers.get('content-type')).toBe('image/png')

    const ico = await fetch(`${base}/favicon.ico`)
    expect(ico.headers.get('content-type')).toBe('image/x-icon')

    const txt = await fetch(`${base}/notes.txt`)
    expect(txt.headers.get('content-type')).toBe('text/plain; charset=utf-8')
  })

  it('answers HEAD with the headers and no body', async () => {
    const { root } = fixture()
    const base = await start(root)
    const response = await fetch(`${base}/`, { method: 'HEAD' })
    expect(response.status).toBe(200)
    expect(Number(response.headers.get('content-length'))).toBeGreaterThan(0)
    expect(await response.text()).toBe('')
  })

  it('returns 404 for missing files, directories and non-GET methods', async () => {
    const { root } = fixture()
    const base = await start(root)
    expect((await fetch(`${base}/missing.txt`)).status).toBe(404)
    // A directory is not served as a listing and is not turned into index.html.
    expect((await fetch(`${base}/sub`)).status).toBe(404)
    expect((await fetch(`${base}/`, { method: 'POST' })).status).toBe(404)
  })

  it('refuses traversal, absolute, encoded, backslash and NUL paths without leaking outside files', async () => {
    const { root, secret } = fixture()
    const base = await start(root)
    const variants = [
      '/../outside/secret.txt',
      '/%2e%2e/outside/secret.txt',
      '/%2e%2e%2foutside%2fsecret.txt',
      '/..%5coutside%5csecret.txt',
      '/%252e%252e%2foutside%2fsecret.txt',
      '/%00',
      '//etc/passwd',
      '/C:/Windows/win.ini',
      '/sub/..%2f..%2foutside%2fsecret.txt',
    ]
    for (const variant of variants) {
      const response = await fetch(`${base}${variant}`)
      const body = await response.text()
      expect(response.status, variant).toBe(404)
      expect(body, variant).not.toContain(secret)
    }
  })

  it('does not follow a symlink that points outside the root', async () => {
    const { root, outside, secret } = fixture()
    const link = join(root, 'escape.txt')
    let created = false
    try {
      symlinkSync(join(outside, 'secret.txt'), link, 'file')
      created = true
    } catch {
      // Windows often denies symlink creation without Developer Mode or elevation; the case is skipped there.
    }
    if (!created) return
    const base = await start(root)
    const response = await fetch(`${base}/escape.txt`)
    const body = await response.text()
    expect(response.status).toBe(404)
    expect(body).not.toContain(secret)
  })
})
