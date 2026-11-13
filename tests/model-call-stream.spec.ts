/**
 * `callModel` with `stream: true`: SSE replies are assembled into the same result shape as a non-streaming call, for
 * both upstream APIs, including usage, truncation and the request body flags. Non-streaming callers are unchanged.
 */
import { describe, expect, it } from 'vitest'
import { CONTEXT_ACK, callModel } from '../src/assessor/model-call.ts'

function sse(events: unknown[]): Response {
  const body = events.map(event => `data: ${typeof event === 'string' ? event : JSON.stringify(event)}\n\n`).join('')
  // Split mid-line to prove chunk boundaries do not matter.
  const bytes = new TextEncoder().encode(body)
  const cut = Math.floor(bytes.length / 2)
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes.slice(0, cut))
      controller.enqueue(bytes.slice(cut))
      controller.close()
    },
  })
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

describe('callModel streaming', () => {
  it('assembles an OpenAI-style stream with usage and sends stream flags', async () => {
    let sent: Record<string, unknown> = {}
    const fake = (async (_url: string, init: RequestInit) => {
      sent = JSON.parse(String(init.body)) as Record<string, unknown>
      return sse([
        { choices: [{ delta: { reasoning_content: '想一想' } }] },
        { choices: [{ delta: { content: '# 第一' } }] },
        { choices: [{ delta: { content: '章正文' }, finish_reason: 'stop' }] },
        { choices: [], usage: { prompt_tokens: 100, completion_tokens: 20, prompt_cache_hit_tokens: 60, prompt_cache_miss_tokens: 40 } },
        '[DONE]',
      ])
    }) as unknown as typeof fetch
    const result = await callModel({ api: 'openai-completions', baseUrl: 'http://x', apiKey: 'k' },
      { model: 'm', system: 's', user: 'u', maxTokens: 10 }, { timeoutMs: 5_000, fetch: fake, stream: true })
    expect(sent.stream).toBe(true)
    expect(sent.stream_options).toEqual({ include_usage: true })
    expect(result.ok).toBe(true)
    expect(result.text).toBe('# 第一章正文')
    expect(result.truncated).toBeUndefined()
    expect(result.usage).toMatchObject({ completion_tokens: 20, prompt_cache_hit_tokens: 60, prompt_cache_miss_tokens: 40 })
  })

  it('reports a length stop as truncated', async () => {
    const fake = (async () => sse([{ choices: [{ delta: { content: '半' }, finish_reason: 'length' }] }, '[DONE]'])) as unknown as typeof fetch
    const result = await callModel({ api: 'openai-completions', baseUrl: 'http://x', apiKey: 'k' },
      { model: 'm', system: 's', user: 'u', maxTokens: 10 }, { timeoutMs: 5_000, fetch: fake, stream: true })
    expect(result.text).toBe('半')
    expect(result.truncated).toBe(true)
  })

  it('assembles an Anthropic stream', async () => {
    const fake = (async () => sse([
      { type: 'message_start', message: { usage: { input_tokens: 50, output_tokens: 1 } } },
      { type: 'content_block_delta', delta: { type: 'text_delta', text: '你好' } },
      { type: 'content_block_delta', delta: { type: 'text_delta', text: '世界' } },
      { type: 'message_delta', delta: { stop_reason: 'max_tokens' }, usage: { output_tokens: 9 } },
    ])) as unknown as typeof fetch
    const result = await callModel({ api: 'anthropic-messages', baseUrl: 'http://x', apiKey: 'k' },
      { model: 'm', system: 's', user: 'u', maxTokens: 10 }, { timeoutMs: 5_000, fetch: fake, stream: true })
    expect(result.text).toBe('你好世界')
    expect(result.truncated).toBe(true)
    expect(result.usage?.completion_tokens).toBe(9)
  })

  it('sends context as its own earlier user turn with a fixed acknowledgement', async () => {
    let sent: { messages?: { role: string; content: string }[] } = {}
    const fake = (async (_url: string, init: RequestInit) => {
      sent = JSON.parse(String(init.body)) as typeof sent
      return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }), { status: 200 })
    }) as unknown as typeof fetch
    await callModel({ api: 'openai-completions', baseUrl: 'http://x', apiKey: 'k' },
      { model: 'm', system: 's', user: 'u', maxTokens: 10, context: '书的设定' }, { timeoutMs: 5_000, fetch: fake })
    expect(sent.messages?.map(m => m.role)).toEqual(['system', 'user', 'assistant', 'user'])
    expect(sent.messages?.[1]?.content).toBe('书的设定')
    expect(sent.messages?.[2]?.content).toBe(CONTEXT_ACK)
    expect(sent.messages?.[3]?.content).toBe('u')
  })

  it('puts Anthropic context into the marked system prompt, with the asked TTL', async () => {
    let sent: { system?: unknown; messages?: unknown[] } = {}
    const fake = (async (_url: string, init: RequestInit) => {
      sent = JSON.parse(String(init.body)) as typeof sent
      return new Response(JSON.stringify({ content: [{ type: 'text', text: 'ok' }] }), { status: 200 })
    }) as unknown as typeof fetch
    const target = { api: 'anthropic-messages' as const, baseUrl: 'http://x', apiKey: 'k' }
    await callModel(target, { model: 'm', system: 's', user: 'u', maxTokens: 10, context: '书的设定' },
      { timeoutMs: 5_000, fetch: fake, cacheTtl: '1h' })
    const mark = { type: 'ephemeral', ttl: '1h' }
    expect(sent.system).toEqual([{ type: 'text', text: 's\n\n书的设定', cache_control: mark }])
    expect(sent.messages).toEqual([{ role: 'user', content: 'u' }])
    await callModel(target, { model: 'm', system: 's', user: 'u', maxTokens: 10 }, { timeoutMs: 5_000, fetch: fake })
    expect(sent.system).toEqual([{ type: 'text', text: 's', cache_control: { type: 'ephemeral' } }])
    expect(sent.messages).toEqual([{ role: 'user', content: 'u' }])
  })

  it('sends no cache markers to OpenAI-style upstreams', async () => {
    let raw = ''
    const fake = (async (_url: string, init: RequestInit) => {
      raw = String(init.body)
      return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }), { status: 200 })
    }) as unknown as typeof fetch
    await callModel({ api: 'openai-completions', baseUrl: 'http://x', apiKey: 'k' },
      { model: 'm', system: 's', user: 'u', maxTokens: 10, context: '书' }, { timeoutMs: 5_000, fetch: fake, cacheTtl: '1h' })
    expect(raw).not.toContain('cache_control')
  })

  it('keeps the non-streaming body when stream is not set', async () => {
    let sent: Record<string, unknown> = {}
    const fake = (async (_url: string, init: RequestInit) => {
      sent = JSON.parse(String(init.body)) as Record<string, unknown>
      return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }), { status: 200 })
    }) as unknown as typeof fetch
    const result = await callModel({ api: 'openai-completions', baseUrl: 'http://x', apiKey: 'k' },
      { model: 'm', system: 's', user: 'u', maxTokens: 10 }, { timeoutMs: 5_000, fetch: fake })
    expect(sent.stream).toBe(false)
    expect(sent.stream_options).toBeUndefined()
    expect(result.text).toBe('ok')
  })
})
