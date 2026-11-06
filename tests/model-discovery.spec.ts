/**
 * Model discovery against a local node:http server: the request shapes, the OpenRouter-style metadata mapping, the
 * Anthropic pagination, the Chinese failure messages, and the rule that the key never comes back in any message.
 * Nothing leaves localhost.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { discoverModels, openAiListUrls } from '../src/admin/model-discovery.ts'

const servers: Server[] = []

async function serve(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<string> {
  const server = createServer((req, res) => {
    req.resume()
    req.on('end', () => handler(req, res))
  })
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('no address')
  return `http://127.0.0.1:${address.port}`
}

function json(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(value))
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))))
})

describe('discoverModels', () => {
  it('reads the openai model list with the bearer and session headers', async () => {
    const paths: string[] = []
    const auth: Array<string | undefined> = []
    const session: Array<string | undefined> = []
    const base = await serve((req, res) => {
      paths.push(req.url ?? '')
      auth.push(req.headers.authorization)
      session.push(req.headers['x-opencode-session'] as string | undefined)
      json(res, 200, { data: [{ id: 'b-model' }, { id: 'a-model' }] })
    })
    const result = await discoverModels(
      { api: 'openai-completions', baseUrl: `${base}/v1/`, apiKey: 'sk-test-123', sessionHeader: 'x-opencode-session' },
      { timeoutMs: 5000 },
    )
    expect(result).toEqual({
      ok: true,
      message: '找到 2 个模型。',
      models: [{ id: 'a-model' }, { id: 'b-model' }],
    })
    expect(paths).toEqual(['/v1/models'])
    expect(auth).toEqual(['Bearer sk-test-123'])
    expect(session).toEqual(['admin-discover'])
  })

  it('maps OpenRouter-style metadata and converts per-token prices to per million', async () => {
    const base = await serve((_req, res) => json(res, 200, {
      data: [
        {
          id: 'vendor/vision-think',
          name: 'Vision Think',
          context_length: 200000,
          top_provider: { max_completion_tokens: 8192 },
          architecture: { input_modalities: ['text', 'image'] },
          supported_parameters: ['reasoning', 'temperature'],
          pricing: { prompt: '0.000003', completion: '0.000015', input_cache_read: '0.0000003' },
        },
        { id: 'plain', pricing: { prompt: '0.000001' } },
      ],
    }))
    const result = await discoverModels({ api: 'openai-completions', baseUrl: base, apiKey: '' }, { timeoutMs: 5000 })
    expect(result.ok).toBe(true)
    expect(result.models.find(m => m.id === 'vendor/vision-think')).toEqual({
      id: 'vendor/vision-think',
      label: 'Vision Think',
      contextWindow: 200000,
      maxTokens: 8192,
      vision: true,
      reasoning: true,
      price: { input: 3, cacheRead: 0.3, output: 15 },
    })
    // No completion price, so no `price` at all; nothing else was reported, so nothing else is set.
    expect(result.models.find(m => m.id === 'plain')).toEqual({ id: 'plain' })
  })

  it('pages through anthropic models with x-api-key and anthropic-version', async () => {
    const urls: string[] = []
    const keys: Array<string | undefined> = []
    const versions: Array<string | undefined> = []
    const base = await serve((req, res) => {
      urls.push(req.url ?? '')
      keys.push(req.headers['x-api-key'] as string | undefined)
      versions.push(req.headers['anthropic-version'] as string | undefined)
      if (!(req.url ?? '').includes('after_id=')) {
        json(res, 200, { data: [{ id: 'claude-b', display_name: 'Claude B' }], has_more: true, last_id: 'claude-b' })
      } else {
        json(res, 200, { data: [{ id: 'claude-a', display_name: 'Claude A' }], has_more: false, last_id: 'claude-a' })
      }
    })
    const result = await discoverModels({ api: 'anthropic-messages', baseUrl: base, apiKey: 'ant-key' }, { timeoutMs: 5000 })
    expect(result.ok).toBe(true)
    expect(result.models).toEqual([{ id: 'claude-a', label: 'Claude A' }, { id: 'claude-b', label: 'Claude B' }])
    expect(urls).toEqual(['/v1/models?limit=1000', '/v1/models?limit=1000&after_id=claude-b'])
    expect(keys).toEqual(['ant-key', 'ant-key'])
    expect(versions).toEqual(['2023-06-01', '2023-06-01'])
  })

  it('explains a 401 without the key', async () => {
    const base = await serve((_req, res) => json(res, 401, { error: 'invalid key' }))
    const result = await discoverModels({ api: 'openai-completions', baseUrl: base, apiKey: 'sk-secret-401' }, { timeoutMs: 5000 })
    expect(result).toEqual({ ok: false, status: 401, message: '密钥不对或没有权限（401）。', models: [] })
  })

  it('explains a 404 as a missing model-list endpoint', async () => {
    const base = await serve((_req, res) => json(res, 404, { error: 'not found' }))
    const result = await discoverModels({ api: 'openai-completions', baseUrl: base, apiKey: '' }, { timeoutMs: 5000 })
    expect(result).toEqual({
      ok: false,
      status: 404,
      message: '这个地址没有模型列表接口（404），可以手动添加模型。',
      models: [],
    })
  })

  it('reports a non-JSON body as unreadable', async () => {
    const base = await serve((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end('<html>maintenance</html>')
    })
    const result = await discoverModels({ api: 'openai-completions', baseUrl: base, apiKey: '' }, { timeoutMs: 5000 })
    expect(result).toEqual({ ok: false, message: '服务商返回的内容看不懂，可以手动添加模型。', models: [] })
  })

  it('reports a timeout as ok:false instead of throwing', async () => {
    const base = await serve(() => {
      // Never answer, so the client's abort is what ends the request.
    })
    const result = await discoverModels({ api: 'openai-completions', baseUrl: base, apiKey: '' }, { timeoutMs: 50 })
    expect(result.ok).toBe(false)
    expect(result.models).toEqual([])
    expect(result.message).toMatch(/^连不上服务商或请求超时：/)
  })

  it('never shows the key, even when the server echoes it in an error body', async () => {
    const key = 'sk-very-secret-echo-999'
    const base = await serve((_req, res) => {
      res.writeHead(500, { 'content-type': 'text/plain' })
      res.end(`bad credentials: ${key}`)
    })
    const result = await discoverModels({ api: 'openai-completions', baseUrl: base, apiKey: key }, { timeoutMs: 5000 })
    expect(result.ok).toBe(false)
    expect(result.status).toBe(500)
    expect(result.message).not.toContain(key)
    expect(JSON.stringify(result)).not.toContain(key)
  })

  it('sends no authorization header when there is no key', async () => {
    const auth: Array<string | undefined> = []
    const base = await serve((req, res) => {
      auth.push(req.headers.authorization)
      json(res, 200, { data: [] })
    })
    const result = await discoverModels({ api: 'openai-completions', baseUrl: base, apiKey: '' }, { timeoutMs: 5000 })
    expect(result).toEqual({ ok: true, message: '找到 0 个模型。', models: [] })
    expect(auth).toEqual([undefined])
  })

  it('lists same-host fallback addresses for the model list', () => {
    expect(openAiListUrls('https://opencode.ai/inference/go/openai/v1')).toEqual([
      'https://opencode.ai/inference/go/openai/v1/models',
      'https://opencode.ai/inference/go/v1/models',
      'https://opencode.ai/inference/v1/models',
      'https://opencode.ai/v1/models',
    ])
    expect(openAiListUrls('https://api.deepseek.com/')).toEqual(['https://api.deepseek.com/models'])
    for (const url of openAiListUrls('https://example.com/a/b/c/d/e/v1')) expect(new URL(url).origin).toBe('https://example.com')
    expect(openAiListUrls('https://example.com/a/b/c/d/e/v1').length).toBeLessThanOrEqual(4)
  })

  it('falls back to a parent path when the inference path has no model list', async () => {
    const paths: string[] = []
    const base = await serve((req, res) => {
      paths.push(req.url ?? '')
      if (req.url === '/inference/go/v1/models') json(res, 200, { data: [{ id: 'deepseek-v4.1-flash' }] })
      else json(res, 404, { error: 'not found' })
    })
    const result = await discoverModels(
      { api: 'openai-completions', baseUrl: `${base}/inference/go/openai/v1`, apiKey: 'sk-x-123456789' },
      { timeoutMs: 5000 },
    )
    expect(result).toMatchObject({ ok: true, models: [{ id: 'deepseek-v4.1-flash' }] })
    expect(paths).toEqual(['/inference/go/openai/v1/models', '/inference/go/v1/models'])
  })

  it('does not try other addresses after an auth error', async () => {
    const paths: string[] = []
    const base = await serve((req, res) => { paths.push(req.url ?? ''); json(res, 401, { error: 'bad key' }) })
    const result = await discoverModels(
      { api: 'openai-completions', baseUrl: `${base}/inference/go/openai/v1`, apiKey: 'sk-x-123456789' },
      { timeoutMs: 5000 },
    )
    expect(result).toMatchObject({ ok: false, status: 401 })
    expect(paths).toEqual(['/inference/go/openai/v1/models'])
  })
})
