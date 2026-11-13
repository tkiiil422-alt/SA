import { afterEach, describe, expect, it } from 'vitest'
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import {
  createGateway, type Authorization, type CallRecord, type Gateway, type GatewayOptions, type UpstreamTarget,
} from '../src/gateway/gateway.ts'
import { cost, costOf, isPeak, type Price } from '../src/gateway/pricing.ts'
import type { Usage } from '../src/gateway/usage.ts'

const REAL_KEY = 'sk-real-upstream-key'
/** The provider id used by most tests; requests go to `/p/main/<path>`. */
const P = '/p/main'
const PRICE: Price = { input: 0.3, cacheRead: 0.006, output: 1.2 }
const MODELS = ['deepseek-flash', 'deepseek-v4.1-flash', 'claude-sonnet-5-5']

interface UpstreamCall {
  method: string | undefined
  url: string | undefined
  headers: IncomingMessage['headers']
  body: Buffer
}

interface FakeUpstream {
  url: string
  calls: UpstreamCall[]
  close(): Promise<void>
}

async function startUpstream(respond: (call: UpstreamCall, res: ServerResponse) => void | Promise<void>): Promise<FakeUpstream> {
  const calls: UpstreamCall[] = []
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      const call = { method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks) }
      calls.push(call)
      void Promise.resolve(respond(call, res)).catch(() => {
        if (!res.writableEnded) res.destroy()
      })
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  return {
    url: `http://127.0.0.1:${port}`,
    calls,
    close: () => new Promise<void>(resolve => {
      server.closeAllConnections()
      server.close(() => resolve())
    }),
  }
}

const cleanups: (() => Promise<void>)[] = []
const track = <T extends { close(): Promise<void> }>(resource: T): T => {
  cleanups.push(() => resource.close())
  return resource
}

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!()
})

interface ClientResponse {
  status: number
  headers: IncomingMessage['headers']
  body: Buffer
}

function call(
  port: number,
  token: string | undefined,
  body: string,
  path = `${P}/v1/chat/completions`,
  extra: Record<string, string> = {},
): Promise<ClientResponse> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'content-length': String(Buffer.byteLength(body)),
      ...extra,
    }
    if (token !== undefined) headers.authorization = `Bearer ${token}`
    const req = httpRequest({ host: '127.0.0.1', port, path, method: 'POST', headers }, res => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('error', reject)
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }))
    })
    req.on('error', reject)
    req.end(body)
  })
}

const targetFor = (upstream: FakeUpstream, overrides: Partial<UpstreamTarget> = {}): UpstreamTarget => ({
  api: 'openai-completions',
  baseUrl: upstream.url,
  apiKey: REAL_KEY,
  models: MODELS,
  ...overrides,
})

interface Harness {
  gateway: Gateway
  port: number
  records: CallRecord[]
  /** The live provider table; changing an entry takes effect on the next request. */
  providers: Map<string, UpstreamTarget>
}

/** A gateway with one provider `main` pointing at `upstream`. Options override the defaults. */
async function gatewayFor(upstream: FakeUpstream, options: Partial<GatewayOptions> = {}): Promise<Harness> {
  const records: CallRecord[] = []
  const providers = new Map<string, UpstreamTarget>([['main', targetFor(upstream)]])
  const gateway = track(createGateway({
    resolveProvider: id => providers.get(id),
    authorize: knownTicket,
    record: entry => records.push(entry),
    price: () => PRICE,
    ...options,
  }))
  const { port } = await gateway.listen()
  return { gateway, port, records, providers }
}

const knownTicket = (token: string): Authorization =>
  token === 'ticket-abc' ? { ticketId: 'TK-1', role: 'worker' } : { denied: 'unknown' }

const okJson = (body: string) => (_call: UpstreamCall, res: ServerResponse): void => {
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(body)
}

async function waitUntil(check: () => boolean, label: string, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`)
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms)
    promise.then(
      value => { clearTimeout(timer); resolve(value) },
      error => { clearTimeout(timer); reject(error) },
    )
  })
}

describe('gateway authorization', () => {
  it('swaps the ticket token for the real upstream key and passes the path and query through', async () => {
    const upstream = track(await startUpstream(okJson('{}')))
    const { port } = await gatewayFor(upstream)

    const response = await call(port, 'ticket-abc', '{"model":"deepseek-flash","messages":[]}', `${P}/v1/chat/completions?stream=false`)

    expect(response.status).toBe(200)
    expect(upstream.calls).toHaveLength(1)
    expect(upstream.calls[0]!.headers.authorization).toBe(`Bearer ${REAL_KEY}`)
    expect(upstream.calls[0]!.headers.authorization).not.toContain('ticket-abc')
    expect(upstream.calls[0]!.url).toBe('/v1/chat/completions?stream=false')
  })

  it('accepts the ticket token in x-api-key', async () => {
    const upstream = track(await startUpstream(okJson('{}')))
    const { port, records } = await gatewayFor(upstream)

    const response = await call(port, undefined, '{"model":"deepseek-flash"}', `${P}/v1/chat/completions`, { 'x-api-key': 'ticket-abc' })

    expect(response.status).toBe(200)
    expect(upstream.calls[0]!.headers.authorization).toBe(`Bearer ${REAL_KEY}`)
    expect(upstream.calls[0]!.headers['x-api-key']).toBeUndefined()
    expect(records[0]!.ticketId).toBe('TK-1')
  })

  it('rejects an unknown token with 401 and never contacts upstream', async () => {
    const upstream = track(await startUpstream(okJson('{}')))
    const { port, records } = await gatewayFor(upstream)

    const response = await call(port, 'not-a-ticket', '{"model":"deepseek-flash"}')

    expect(response.status).toBe(401)
    expect(JSON.parse(response.body.toString('utf8'))).toMatchObject({ error: { type: 'unknown_token' } })
    expect(upstream.calls).toHaveLength(0)
    expect(records).toHaveLength(0)
  })

  it('rejects a spent budget with 402 and never contacts upstream', async () => {
    const upstream = track(await startUpstream(okJson('{}')))
    const { port, records } = await gatewayFor(upstream, { authorize: () => ({ denied: 'budget' }) })

    const response = await call(port, 'ticket-abc', '{"model":"deepseek-flash"}')

    expect(response.status).toBe(402)
    expect(JSON.parse(response.body.toString('utf8'))).toMatchObject({ error: { type: 'budget_exhausted' } })
    expect(upstream.calls).toHaveLength(0)
    expect(records).toHaveLength(0)
  })
})

describe('gateway provider routing', () => {
  it('routes two providers to two different upstreams by path prefix', async () => {
    const a = track(await startUpstream(okJson('{"from":"a"}')))
    const b = track(await startUpstream(okJson('{"from":"b"}')))
    const records: CallRecord[] = []
    const gateway = track(createGateway({
      resolveProvider: id => id === 'alpha' ? targetFor(a) : id === 'beta' ? targetFor(b, { api: 'anthropic-messages' }) : undefined,
      authorize: knownTicket,
      record: entry => records.push(entry),
      price: () => PRICE,
    }))
    const { port } = await gateway.listen()

    const first = await call(port, 'ticket-abc', '{"model":"deepseek-flash"}', '/p/alpha/v1/chat/completions')
    const second = await call(port, 'ticket-abc', '{"model":"claude-sonnet-5-5"}', '/p/beta/v1/messages')

    expect(first.body.toString('utf8')).toBe('{"from":"a"}')
    expect(second.body.toString('utf8')).toBe('{"from":"b"}')
    expect(a.calls).toHaveLength(1)
    expect(a.calls[0]!.url).toBe('/v1/chat/completions')
    expect(b.calls).toHaveLength(1)
    expect(b.calls[0]!.url).toBe('/v1/messages')
    expect(records.map(record => record.provider)).toEqual(['alpha', 'beta'])
  })

  it('answers an unknown provider with 404 before the body is read, and records nothing', async () => {
    const upstream = track(await startUpstream(okJson('{}')))
    const { port, records } = await gatewayFor(upstream)

    const unknown = await call(port, 'ticket-abc', '{"model":"deepseek-flash"}', '/p/nope/v1/chat/completions')
    const noPrefix = await call(port, 'ticket-abc', '{"model":"deepseek-flash"}', '/v1/chat/completions')

    expect(unknown.status).toBe(404)
    expect(JSON.parse(unknown.body.toString('utf8'))).toMatchObject({ error: { type: 'unknown_provider' } })
    expect(noPrefix.status).toBe(404)
    expect(JSON.parse(noPrefix.body.toString('utf8'))).toMatchObject({ error: { type: 'unknown_provider' } })
    expect(upstream.calls).toHaveLength(0)
    expect(records).toHaveLength(0)
  })

  it('resolves the provider on every request, so a changed target or key takes effect without restart', async () => {
    const a = track(await startUpstream(okJson('{}')))
    const b = track(await startUpstream(okJson('{}')))
    const { port, providers, records } = await gatewayFor(a)

    await call(port, 'ticket-abc', '{"model":"deepseek-flash"}')
    expect(a.calls).toHaveLength(1)

    providers.set('main', targetFor(b, { apiKey: 'sk-rotated' }))
    await call(port, 'ticket-abc', '{"model":"deepseek-flash"}')
    expect(a.calls).toHaveLength(1)
    expect(b.calls).toHaveLength(1)
    expect(b.calls[0]!.headers.authorization).toBe('Bearer sk-rotated')

    providers.delete('main')
    const gone = await call(port, 'ticket-abc', '{"model":"deepseek-flash"}')
    expect(gone.status).toBe(404)
    expect(records).toHaveLength(2)
  })

  it('gives an anthropic provider x-api-key with the real key and no authorization header', async () => {
    const upstream = track(await startUpstream(okJson('{"ok":true}')))
    const gateway = track(createGateway({
      resolveProvider: () => targetFor(upstream, { api: 'anthropic-messages' }),
      authorize: knownTicket,
      record: () => {},
    }))
    const { port } = await gateway.listen()

    const response = await call(port, 'ticket-abc', '{"model":"claude-sonnet-5-5","messages":[]}', '/p/anthropic/v1/messages', {
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'prompt-caching-2024-07-31',
    })

    expect(response.status).toBe(200)
    const forwarded = upstream.calls[0]!
    expect(forwarded.headers['x-api-key']).toBe(REAL_KEY)
    expect(forwarded.headers.authorization).toBeUndefined()
    expect(forwarded.headers['anthropic-version']).toBe('2023-06-01')
    expect(forwarded.headers['anthropic-beta']).toBe('prompt-caching-2024-07-31')
  })

  it('gives an openai provider a bearer key and no x-api-key header', async () => {
    const upstream = track(await startUpstream(okJson('{"ok":true}')))
    const { port } = await gatewayFor(upstream)

    await call(port, 'ticket-abc', '{"model":"deepseek-flash"}')

    const forwarded = upstream.calls[0]!
    expect(forwarded.headers.authorization).toBe(`Bearer ${REAL_KEY}`)
    expect(forwarded.headers['x-api-key']).toBeUndefined()
  })

  it('never forwards client x-api-key or authorization credentials', async () => {
    const upstream = track(await startUpstream(okJson('{"ok":true}')))
    const { port } = await gatewayFor(upstream)

    await call(port, 'ticket-abc', '{"model":"deepseek-flash"}', `${P}/v1/chat/completions`, { 'x-api-key': 'forged-client-key' })

    const forwarded = upstream.calls[0]!
    expect(forwarded.headers['x-api-key']).toBeUndefined()
    expect(forwarded.headers.authorization).toBe(`Bearer ${REAL_KEY}`)
    expect(JSON.stringify(forwarded.headers)).not.toContain('forged-client-key')
    expect(JSON.stringify(forwarded.headers)).not.toContain('ticket-abc')
  })

  it('never forwards a client authorization header to an anthropic provider', async () => {
    const upstream = track(await startUpstream(okJson('{"ok":true}')))
    const gateway = track(createGateway({
      resolveProvider: () => targetFor(upstream, { api: 'anthropic-messages' }),
      authorize: knownTicket,
      record: () => {},
    }))
    const { port } = await gateway.listen()

    await call(port, 'ticket-abc', '{"model":"claude-sonnet-5-5"}', '/p/anthropic/v1/messages')

    const forwarded = upstream.calls[0]!
    expect(forwarded.headers.authorization).toBeUndefined()
    expect(forwarded.headers['x-api-key']).toBe(REAL_KEY)
    expect(JSON.stringify(forwarded.headers)).not.toContain('ticket-abc')
  })
})

describe('gateway forwarding', () => {
  it('forwards the request body byte-for-byte, including unusual whitespace, key order, and non-ASCII text', async () => {
    const upstream = track(await startUpstream(okJson('{}')))
    const { port } = await gatewayFor(upstream)
    const raw = '{\n\t"zeta": 1,   "model" : "deepseek-flash",\n\t"messages": [ { "role" : "user", "content" : "你好  世界" } ],\n\t"alpha": [1, 2,3],\n\t"pad": "  "  \n}'

    const response = await call(port, 'ticket-abc', raw)

    expect(response.status).toBe(200)
    expect(upstream.calls).toHaveLength(1)
    expect(upstream.calls[0]!.body.equals(Buffer.from(raw, 'utf8'))).toBe(true)
    expect(upstream.calls[0]!.headers['content-length']).toBe(String(Buffer.byteLength(raw)))
  })

  it('appends the incoming path to a provider base URL that has a path prefix', async () => {
    const upstream = track(await startUpstream(okJson('{"ok":true}')))
    const { port, providers } = await gatewayFor(upstream)
    providers.set('main', targetFor(upstream, { baseUrl: `${upstream.url}/inference/go/openai/v1` }))

    await call(port, 'ticket-abc', '{"model":"deepseek-v4.1-flash"}', `${P}/chat/completions?x=1`)

    expect(upstream.calls[0]!.url).toBe('/inference/go/openai/v1/chat/completions?x=1')
  })

  it('returns an upstream 500 and its body unchanged, and records the failed call', async () => {
    const upstream = track(await startUpstream((_call, res) => {
      res.writeHead(500, { 'content-type': 'application/json' })
      res.end('{"error":{"message":"boom"}}')
    }))
    const { port, records } = await gatewayFor(upstream)

    const response = await call(port, 'ticket-abc', '{"model":"deepseek-flash"}')

    expect(response.status).toBe(500)
    expect(response.body.toString('utf8')).toBe('{"error":{"message":"boom"}}')
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({ ticketId: 'TK-1', role: 'worker', provider: 'main', model: 'deepseek-flash', status: 500, costUsd: 0 })
    expect(records[0]!.usage).toBeUndefined()
  })
})

describe('gateway non-streaming usage', () => {
  it('reads usage from a JSON response and prices it per provider', async () => {
    const usage: Usage = { prompt_tokens: 1000, completion_tokens: 200, prompt_cache_hit_tokens: 600, prompt_cache_miss_tokens: 400 }
    const payload = JSON.stringify({ id: 'chat-1', choices: [], usage })
    const upstream = track(await startUpstream(okJson(payload)))
    const { port, records } = await gatewayFor(upstream)

    const response = await call(port, 'ticket-abc', '{"model":"deepseek-flash"}')

    expect(response.status).toBe(200)
    expect(response.body.toString('utf8')).toBe(payload)
    const record = records[0]!
    expect(record.usage).toEqual(usage)
    expect(record.status).toBe(200)
    expect(record.model).toBe('deepseek-flash')
    expect(record.provider).toBe('main')
    // 400 uncached * 0.3 + 600 cache-read * 0.006 + 200 output * 1.2, per million tokens.
    expect(record.costUsd).toBeCloseTo(0.0003636, 12)
  })

  it('reads cache hits from prompt_tokens_details.cached_tokens when the upstream reports them that way', async () => {
    const payload = JSON.stringify({
      id: 'chat-2',
      choices: [],
      usage: { prompt_tokens: 1000, completion_tokens: 200, prompt_tokens_details: { cached_tokens: 600 } },
    })
    const upstream = track(await startUpstream(okJson(payload)))
    const { port, records } = await gatewayFor(upstream)

    await call(port, 'ticket-abc', '{"model":"deepseek-v4.1-flash"}')

    const record = records[0]!
    expect(record.usage).toEqual({
      prompt_tokens: 1000,
      completion_tokens: 200,
      prompt_cache_hit_tokens: 600,
      prompt_cache_miss_tokens: 400,
    })
    expect(record.model).toBe('deepseek-v4.1-flash')
    expect(record.costUsd).toBeGreaterThan(0)
  })

  it('records zero cost when the provider has no price for the model', async () => {
    const usage: Usage = { prompt_tokens: 10, completion_tokens: 5, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 10 }
    const upstream = track(await startUpstream(okJson(JSON.stringify({ usage }))))
    const { port, records } = await gatewayFor(upstream, { price: () => undefined })

    await call(port, 'ticket-abc', '{"model":"deepseek-flash"}')

    expect(records[0]!.usage).toEqual(usage)
    expect(records[0]!.costUsd).toBe(0)
  })
})

describe('gateway streaming usage', () => {
  it('extracts usage from SSE and delivers the first event before upstream finishes', async () => {
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const upstream = track(await startUpstream(async (_call, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      res.write('data: {"choices":[{"delta":{"content":"你好"}}]}\n\n')
      await gate
      res.write('data: {"choices":[{"delta":{"content":"世界"}}],"usage":{"prompt_tokens":11,"completion_tokens":7,"prompt_cache_hit_tokens":5,"prompt_cache_miss_tokens":6}}\n\n')
      res.write('data: [DONE]\n\n')
      res.end()
    }))
    const { port, records } = await gatewayFor(upstream)

    let text = ''
    let sawFirst = false
    let resolveFirst!: (value: string) => void
    let rejectFirst!: (reason: unknown) => void
    const first = new Promise<string>((resolve, reject) => { resolveFirst = resolve; rejectFirst = reject })
    void first.catch(() => {})
    const done = new Promise<string>((resolve, reject) => {
      const body = '{"model":"deepseek-flash","stream":true,"messages":[]}'
      const req = httpRequest({
        host: '127.0.0.1', port, path: `${P}/v1/chat/completions`, method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)), authorization: 'Bearer ticket-abc' },
      }, res => {
        res.setEncoding('utf8')
        res.on('data', (chunk: string) => {
          text += chunk
          if (!sawFirst && text.includes('你好')) {
            sawFirst = true
            resolveFirst(text)
          }
        })
        res.on('end', () => resolve(text))
      })
      req.on('error', error => { reject(error); rejectFirst(error) })
      req.end(body)
    })

    const firstText = await withTimeout(first, 2000, 'first SSE event did not arrive while upstream was still open')
    expect(firstText).toContain('你好')
    expect(firstText).not.toContain('世界')

    release()
    const full = await withTimeout(done, 2000, 'SSE stream did not finish')
    expect(full).toContain('data: [DONE]')

    expect(records).toHaveLength(1)
    const record = records[0]!
    expect(record.status).toBe(200)
    expect(record.usage).toEqual({ prompt_tokens: 11, completion_tokens: 7, prompt_cache_hit_tokens: 5, prompt_cache_miss_tokens: 6 })
    expect(record.costUsd).toBeCloseTo(costOf(PRICE, record.usage!), 12)
  })
})

describe('gateway upstream headers', () => {
  it('adds the upstream headers resolved per provider and forwards the body unchanged', async () => {
    const upstream = track(await startUpstream(okJson('{"ok":true}')))
    const { port } = await gatewayFor(upstream, {
      upstreamHeaders: (auth, providerId) => ({ 'x-opencode-session': `${providerId}:${auth.ticketId}` }),
    })
    const body = '{"model":"deepseek-v4.1-flash","messages":[]}'

    const response = await call(port, 'ticket-abc', body)

    expect(response.status).toBe(200)
    const forwarded = upstream.calls[0]!
    expect(forwarded.headers['x-opencode-session']).toBe('main:TK-1')
    expect(forwarded.headers.authorization).toBe(`Bearer ${REAL_KEY}`)
    expect(forwarded.body.toString('utf8')).toBe(body)
  })
})

describe('gateway request handling', () => {
  it('authorizes before reading the body and rejects without buffering it', async () => {
    const upstream = track(await startUpstream(okJson('{}')))
    const { port, records } = await gatewayFor(upstream)
    let request: ReturnType<typeof httpRequest> | undefined

    const response = await withTimeout(new Promise<ClientResponse>((resolve, reject) => {
      request = httpRequest({
        host: '127.0.0.1',
        port,
        path: `${P}/v1/chat/completions`,
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': '1000000' },
      }, res => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }))
      })
      request.on('error', reject)
      // Only part of the body, never ended: a gateway that read the body first would never answer.
      request.write('{"model":"deepseek-flash"')
    }), 1000, 'the gateway waited for the request body before answering')

    request?.destroy()
    expect(response.status).toBe(401)
    expect(JSON.parse(response.body.toString('utf8'))).toMatchObject({ error: { type: 'unknown_token' } })
    expect(upstream.calls).toHaveLength(0)
    expect(records).toHaveLength(0)
  })

  it('answers 413 when the body exceeds maxBodyBytes and never contacts upstream', async () => {
    const upstream = track(await startUpstream(okJson('{}')))
    const { port, records } = await gatewayFor(upstream, { maxBodyBytes: 32 })
    const body = JSON.stringify({ model: 'deepseek-flash', pad: 'x'.repeat(200) })

    const response = await call(port, 'ticket-abc', body)

    expect(response.status).toBe(413)
    expect(JSON.parse(response.body.toString('utf8'))).toMatchObject({ error: { type: 'body_too_large' } })
    expect(upstream.calls).toHaveLength(0)
    expect(records).toHaveLength(0)
  })

  it('drops the oldest images to fit the body limit instead of answering 413, keeping the newest', async () => {
    const upstream = track(await startUpstream(okJson('{}')))
    const { port } = await gatewayFor(upstream, { maxBodyBytes: 4_000 })
    const image = (tag: string) => ({ type: 'image_url', image_url: { url: `data:image/png;base64,${tag}${'A'.repeat(1_500)}` } })
    const body = JSON.stringify({
      model: 'deepseek-flash',
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'first' }, image('OLD1')] },
        { role: 'user', content: [image('OLD2')] },
        { role: 'user', content: [{ type: 'text', text: 'latest' }, image('NEW')] },
      ],
    })
    expect(Buffer.byteLength(body)).toBeGreaterThan(4_000)

    const response = await call(port, 'ticket-abc', body)

    expect(response.status).toBe(200)
    expect(upstream.calls).toHaveLength(1)
    const sent = upstream.calls[0]!.body.toString('utf8')
    expect(sent.length).toBeLessThanOrEqual(4_000)
    expect(sent).not.toContain('OLD1')
    expect(sent).toContain('NEW')
    expect(sent).toContain('较早的截图已省略')
  })

  it('still answers 413 when a body without images is over the limit', async () => {
    const upstream = track(await startUpstream(okJson('{}')))
    const { port } = await gatewayFor(upstream, { maxBodyBytes: 64 })
    const body = JSON.stringify({ model: 'deepseek-flash', messages: [{ role: 'user', content: 'x'.repeat(500) }] })
    const response = await call(port, 'ticket-abc', body)
    expect(response.status).toBe(413)
    expect(upstream.calls).toHaveLength(0)
  })

  it('returns 504 and records the call when upstream never sends headers', async () => {
    const upstream = track(await startUpstream(() => { /* never respond */ }))
    const { port, records } = await gatewayFor(upstream, { upstreamTimeoutMs: 100 })

    const response = await call(port, 'ticket-abc', '{"model":"deepseek-flash"}')

    expect(response.status).toBe(504)
    expect(JSON.parse(response.body.toString('utf8'))).toMatchObject({ error: { type: 'upstream_timeout' } })
    await waitUntil(() => records.length === 1, 'the timeout record')
    expect(records[0]).toMatchObject({ status: 504, ticketId: 'TK-1', provider: 'main' })
  })

  it('destroys the client response when the upstream stream idles after its headers', async () => {
    const upstream = track(await startUpstream((_call, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write('data: {"choices":[]}\n\n')
      // Keep the stream open without another chunk.
    }))
    const { port, records } = await gatewayFor(upstream, { upstreamTimeoutMs: 100 })

    const outcome = await withTimeout(new Promise<string>(resolve => {
      const body = '{"model":"deepseek-flash","stream":true}'
      const request = httpRequest({
        host: '127.0.0.1', port, path: `${P}/v1/chat/completions`, method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)), authorization: 'Bearer ticket-abc' },
      }, res => {
        res.on('data', () => {})
        res.on('end', () => resolve('end'))
        res.on('close', () => resolve('closed'))
        res.on('error', () => resolve('closed'))
      })
      request.on('error', () => resolve('closed'))
      request.end(body)
    }), 2000, 'the gateway kept the timed-out stream open')

    expect(outcome).toBe('closed')
    await waitUntil(() => records.length === 1, 'the timeout record')
    expect(records[0]!.status).toBe(504)
  })
})

describe('gateway isolation and routing details', () => {
  it('drops client-supplied x-opencode headers before adding the gateway ones', async () => {
    const upstream = track(await startUpstream(okJson('{"ok":true}')))
    const { port } = await gatewayFor(upstream, {
      upstreamHeaders: auth => ({ 'x-opencode-session': auth.ticketId }),
    })

    const response = await call(port, 'ticket-abc', '{"model":"deepseek-v4.1-flash"}', `${P}/v1/chat/completions`, {
      'x-opencode-session': 'forged-session',
      'x-opencode-something-else': 'forged',
    })

    expect(response.status).toBe(200)
    const forwarded = upstream.calls[0]!
    expect(forwarded.headers['x-opencode-session']).toBe('TK-1')
    expect(forwarded.headers['x-opencode-something-else']).toBeUndefined()
  })

  it('drops every x-opencode header even when the gateway adds none', async () => {
    const upstream = track(await startUpstream(okJson('{"ok":true}')))
    const { port } = await gatewayFor(upstream)

    await call(port, 'ticket-abc', '{"model":"deepseek-flash"}', `${P}/v1/chat/completions`, {
      'x-opencode-session': 'forged-session',
      'x-opencode-foo': 'forged',
    })

    const forwarded = upstream.calls[0]!
    expect(Object.keys(forwarded.headers).some(name => name.startsWith('x-opencode-'))).toBe(false)
  })

  it('keeps the upstream base query and lets incoming parameters win by name', async () => {
    const upstream = track(await startUpstream(okJson('{"ok":true}')))
    const { port, providers } = await gatewayFor(upstream)
    providers.set('main', targetFor(upstream, { baseUrl: `${upstream.url}/inference/go/openai/v1?keep=base&both=base` }))

    await call(port, 'ticket-abc', '{"model":"deepseek-v4.1-flash"}', `${P}/chat/completions?both=incoming&extra=incoming`)

    expect(upstream.calls[0]!.url).toBe('/inference/go/openai/v1/chat/completions?keep=base&both=incoming&extra=incoming')
  })
})

describe('gateway model allowlist', () => {
  it('forwards a request whose body names a model the provider allows', async () => {
    const upstream = track(await startUpstream(okJson('{"ok":true}')))
    const { port, records, providers } = await gatewayFor(upstream)
    providers.set('main', targetFor(upstream, { models: ['deepseek-flash'] }))

    const response = await call(port, 'ticket-abc', '{"model":"deepseek-flash","messages":[]}')

    expect(response.status).toBe(200)
    expect(upstream.calls).toHaveLength(1)
    expect(records).toHaveLength(1)
    expect(records[0]!.model).toBe('deepseek-flash')
  })

  it('rejects a model outside the provider allowlist with 400, without upstream traffic or a record', async () => {
    const upstream = track(await startUpstream(okJson('{"ok":true}')))
    const { port, records, providers } = await gatewayFor(upstream)
    providers.set('main', targetFor(upstream, { models: ['deepseek-flash'] }))

    const response = await call(port, 'ticket-abc', '{"model":"deepseek-v4.1-flash"}')

    expect(response.status).toBe(400)
    expect(JSON.parse(response.body.toString('utf8'))).toMatchObject({ error: { type: 'model_not_allowed' } })
    expect(upstream.calls).toHaveLength(0)
    expect(records).toHaveLength(0)
  })

  it('rejects a body with no readable model with 400', async () => {
    const upstream = track(await startUpstream(okJson('{"ok":true}')))
    const { port } = await gatewayFor(upstream)

    const response = await call(port, 'ticket-abc', 'not json at all')

    expect(response.status).toBe(400)
    expect(JSON.parse(response.body.toString('utf8'))).toMatchObject({ error: { type: 'model_not_allowed' } })
    expect(upstream.calls).toHaveLength(0)
  })
})

describe('gateway interrupted streams', () => {
  it('records usage already seen in an SSE stream when the client disconnects', async () => {
    const usage = { prompt_tokens: 11, completion_tokens: 7, prompt_cache_hit_tokens: 5, prompt_cache_miss_tokens: 6 }
    const upstream = track(await startUpstream((_call, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(`data: {"choices":[],"usage":${JSON.stringify(usage)}}\n\n`)
      // Never finish: the client leaves first.
    }))
    const { port, records } = await gatewayFor(upstream)
    const body = '{"model":"deepseek-flash","stream":true,"messages":[]}'

    await new Promise<void>(resolve => {
      const request = httpRequest({
        host: '127.0.0.1', port, path: `${P}/v1/chat/completions`, method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)), authorization: 'Bearer ticket-abc' },
      }, res => {
        res.on('data', () => {
          request.destroy()
          resolve()
        })
        res.on('error', () => {})
      })
      request.on('error', () => {})
      request.end(body)
    })

    await waitUntil(() => records.length === 1, 'the usage record of the interrupted stream')
    expect(records[0]!.usage).toEqual(usage)
    expect(records[0]!.model).toBe('deepseek-flash')
    expect(records[0]!.costUsd).toBeGreaterThan(0)
  })
})

describe('pricing', () => {
  const usage: Usage = { prompt_tokens: 2_000_000, completion_tokens: 1_000_000, prompt_cache_hit_tokens: 1_000_000, prompt_cache_miss_tokens: 1_000_000 }

  it('costOf prices uncached input, cache reads and output at their own rates with no time-of-day discount', () => {
    // 1M * 0.3 + 1M * 0.006 + 1M * 1.2, per million tokens.
    expect(costOf(PRICE, usage)).toBeCloseTo(1.506, 12)
  })

  it('recognizes peak windows on UTC weekdays and treats weekends as off-peak', () => {
    expect(isPeak(new Date('2026-11-02T00:59:00Z'))).toBe(false) // Monday
    expect(isPeak(new Date('2026-11-02T01:00:00Z'))).toBe(true)
    expect(isPeak(new Date('2026-11-02T03:59:00Z'))).toBe(true)
    expect(isPeak(new Date('2026-11-02T04:00:00Z'))).toBe(false)
    expect(isPeak(new Date('2026-11-02T06:00:00Z'))).toBe(true)
    expect(isPeak(new Date('2026-11-02T09:59:00Z'))).toBe(true)
    expect(isPeak(new Date('2026-11-02T10:00:00Z'))).toBe(false)
    expect(isPeak(new Date('2026-11-07T02:00:00Z'))).toBe(false) // Saturday
    expect(isPeak(new Date('2026-11-08T06:30:00Z'))).toBe(false) // Sunday
  })

  it('charges peak rates on deepseek-flash within a peak window', () => {
    expect(cost('deepseek-flash', usage, new Date('2026-11-04T02:00:00Z'))).toBeCloseTo(1.506, 12)
  })

  it('charges half the peak rate off-peak', () => {
    expect(cost('deepseek-flash', usage, new Date('2026-11-04T12:00:00Z'))).toBeCloseTo(0.753, 12)
  })

  it('prices deepseek-v4.1-flash at the same rates as deepseek-flash', () => {
    expect(cost('deepseek-v4.1-flash', usage, new Date('2026-11-04T02:00:00Z'))).toBeCloseTo(1.506, 12)
  })

  it('prices deepseek-v4-pro at peak and off-peak from the same table', () => {
    expect(cost('deepseek-v4-pro', usage, new Date('2026-11-04T06:30:00Z'))).toBeCloseTo(5.324, 12)
    expect(cost('deepseek-v4-pro', usage, new Date('2026-11-04T20:00:00Z'))).toBeCloseTo(2.662, 12)
  })
})

describe('gateway stall detection', () => {
  it('answers 504 early when upstream sends no headers within headersTimeoutMs', async () => {
    const upstream = track(await startUpstream(() => { /* never respond */ }))
    const { port, records } = await gatewayFor(upstream, { headersTimeoutMs: 80, upstreamTimeoutMs: 5000 })
    const started = Date.now()
    const response = await call(port, 'ticket-abc', '{"model":"deepseek-flash"}')
    expect(response.status).toBe(504)
    expect(Date.now() - started).toBeLessThan(2000)
    await waitUntil(() => records.length === 1, 'the record')
    expect(records[0]!.status).toBe(504)
  })

  it('cuts an event stream that only sends pings for stallTimeoutMs, but not one with content', async () => {
    const upstream = track(await startUpstream((_call, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      const t = setInterval(() => { if (!res.writableEnded) res.write('event: ping\ndata: {"type": "ping"}\n\n') }, 20)
      res.on('close', () => clearInterval(t))
    }))
    const { port, records } = await gatewayFor(upstream, { stallTimeoutMs: 150, upstreamTimeoutMs: 5000 })
    const outcome = await withTimeout(new Promise<string>(resolve => {
      const body = '{"model":"deepseek-flash","stream":true}'
      const request = httpRequest({
        host: '127.0.0.1', port, path: `${P}/v1/chat/completions`, method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)), authorization: 'Bearer ticket-abc' },
      }, res => { res.on('data', () => {}); res.on('end', () => resolve('end')); res.on('close', () => resolve('closed')); res.on('error', () => resolve('closed')) })
      request.on('error', () => resolve('closed'))
      request.end(body)
    }), 3000, 'the gateway kept the ping-only stream open')
    expect(['closed', 'end']).toContain(outcome)
    await waitUntil(() => records.length === 1, 'the stall record')
    expect(records[0]!.status).toBe(504)
  })

  it('treats ping lines as no content and data lines as content', async () => {
    const { sseHasContent } = await import('../src/gateway/gateway.ts')
    expect(sseHasContent(Buffer.from('event: ping\ndata: {"type": "ping"}\n\n'))).toBe(false)
    expect(sseHasContent(Buffer.from(': keepalive\n\n'))).toBe(false)
    expect(sseHasContent(Buffer.from('event: content_block_delta\ndata: {"type":"content_block_delta"}\n\n'))).toBe(true)
  })
})

