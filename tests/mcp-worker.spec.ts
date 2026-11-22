import { afterEach, describe, expect, it, vi } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { UserError } from '../src/core/index.ts'
import { createWorkerMcpServer, WORKER_TOOL_NAMES, type WorkerEngine, type WorkerMcpServerOptions } from '../src/mcp/worker-server.ts'

const cleanup: (() => Promise<void>)[] = []

afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!()
})

const stubEngine = () => ({
  report: vi.fn(),
  reply: vi.fn(),
  handback: vi.fn(),
  markUnrelated: vi.fn(),
  followForContext: vi.fn(),
})

type EngineStub = ReturnType<typeof stubEngine>

const authorize = (token: string): { ticketId: string } | undefined =>
  token === 'ticket-a' ? { ticketId: 'TK-A' } : token === 'ticket-b' ? { ticketId: 'TK-B' } : undefined

async function serve(engine: WorkerEngine, onError?: WorkerMcpServerOptions['onError'], extra: Partial<WorkerMcpServerOptions> = {}) {
  const server = createWorkerMcpServer({ engine, authorize, onError, ...extra })
  const { port } = await server.listen()
  cleanup.push(() => server.close())
  return { server, port, url: new URL(`http://127.0.0.1:${port}/mcp`) }
}

async function clientFor(url: URL, token: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  })
  const client = new Client({ name: 'worker-test', version: '1.0.0' })
  await client.connect(transport)
  cleanup.push(() => client.close())
  return client
}

describe('worker MCP endpoint', () => {
  it('lists every tool in a stable order, with no ticket id in any schema', async () => {
    const { url } = await serve(stubEngine())
    const client = await clientFor(url, 'ticket-a')

    const { tools } = await client.listTools()

    expect(tools.map(tool => tool.name)).toEqual([...WORKER_TOOL_NAMES])
    for (const tool of tools) {
      expect(tool.inputSchema.type).toBe('object')
      expect(Object.keys(tool.inputSchema.properties ?? {})).not.toContain('ticketId')
      expect(JSON.stringify(tool.inputSchema)).not.toContain('ticketId')
    }
  })

  it('derives the ticket from the bearer token for each caller', async () => {
    const engine = stubEngine()
    const { url } = await serve(engine)
    const first = await clientFor(url, 'ticket-a')
    const second = await clientFor(url, 'ticket-b')

    await first.callTool({ name: 'sa_report', arguments: { state: 'progress', summary: 'first works' } })
    await second.callTool({ name: 'sa_report', arguments: { state: 'waiting', summary: 'second waits' } })

    expect(engine.report).toHaveBeenCalledTimes(2)
    expect(engine.report).toHaveBeenNthCalledWith(1, 'TK-A', { state: 'progress', summary: 'first works' })
    expect(engine.report).toHaveBeenNthCalledWith(2, 'TK-B', { state: 'waiting', summary: 'second waits' })
  })

  it('rejects an unknown token with HTTP 401 before MCP handling', async () => {
    const engine = stubEngine()
    const { port } = await serve(engine)

    const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer not-a-ticket' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    })

    expect(response.status).toBe(401)
    expect(engine.report).not.toHaveBeenCalled()
  })

  it('returns a validation error and does not call the Engine for invalid arguments', async () => {
    const engine = stubEngine()
    const { url } = await serve(engine)
    const client = await clientFor(url, 'ticket-a')

    const badState = await client.callTool({ name: 'sa_report', arguments: { state: 'unknown', summary: 'bad state' } })
    const extraTicket = await client.callTool({ name: 'sa_report', arguments: { state: 'progress', summary: 'x', ticketId: 'TK-B' } })

    for (const result of [badState, extraTicket]) {
      expect(result.isError).toBe(true)
      expect(result.content).toMatchObject([{ type: 'text', text: expect.stringMatching(/Input validation error/) }])
    }
    expect(engine.report).not.toHaveBeenCalled()
  })

  it('accepts answering a person\'s question and asking a new one in the same report', async () => {
    const engine = stubEngine()
    const { url } = await serve(engine)
    const client = await clientFor(url, 'ticket-a')

    const result = await client.callTool({
      name: 'sa_report',
      arguments: { state: 'progress', summary: 'answered and asked', answer_to: 'human-1', question: 'Which branch?' },
    })

    expect(result.isError).toBeFalsy()
    expect(engine.report).toHaveBeenCalledWith('TK-A', {
      state: 'progress', summary: 'answered and asked', question: 'Which branch?', answers: 'human-1',
    })
  })

  it('turns a UserError into an error result with its message', async () => {
    const engine: EngineStub = stubEngine()
    engine.report.mockImplementation(() => { throw new UserError('ticketEnded') })
    const { url } = await serve(engine)
    const client = await clientFor(url, 'ticket-a')

    const result = await client.callTool({ name: 'sa_report', arguments: { state: 'progress', summary: 'still working' } })

    expect(result.isError).toBe(true)
    expect(result.content).toEqual([{ type: 'text', text: 'Ticket has ended' }])
  })

  it('turns any other failure into a short error result and reports the details to onError', async () => {
    const engine: EngineStub = stubEngine()
    const failure = new Error('database password leaked here')
    engine.report.mockImplementation(() => { throw failure })
    const onError = vi.fn()
    const { url } = await serve(engine, onError)
    const client = await clientFor(url, 'ticket-a')

    const result = await client.callTool({ name: 'sa_report', arguments: { state: 'progress', summary: 'still working' } })

    expect(result.isError).toBe(true)
    expect(result.content).toEqual([{ type: 'text', text: 'The tool failed unexpectedly.' }])
    expect(onError).toHaveBeenCalledWith(failure, { tool: 'sa_report', ticketId: 'TK-A' })
  })

  it('stores an AI secret bound to the ticket and never echoes the value', async () => {
    const engine = stubEngine()
    const calls: { ticketId: string; name: string; value: string; description?: string }[] = []
    const { url } = await serve(engine, undefined, {
      secretStore: (ticketId, input) => {
        calls.push({ ticketId, ...input })
        return { ok: true, name: input.name }
      },
    })
    const client = await clientFor(url, 'ticket-a')

    const result = await client.callTool({
      name: 'sa_secret_store',
      arguments: { name: 'API_TOKEN', value: 'super-secret-value', description: 'for the API' },
    })

    expect(calls).toEqual([{ ticketId: 'TK-A', name: 'API_TOKEN', value: 'super-secret-value', description: 'for the API' }])
    expect(result.isError).toBeFalsy()
    expect(JSON.stringify(result)).not.toContain('super-secret-value')
    expect(result.content).toMatchObject([{ type: 'text', text: expect.stringContaining('API_TOKEN') }])
  })

  it('reports a refused AI store (an existing name) as a tool error', async () => {
    const engine = stubEngine()
    const { url } = await serve(engine, undefined, {
      secretStore: (_ticketId, input) => ({ ok: false, message: `同名密钥已存在：${input.name}` }),
    })
    const client = await clientFor(url, 'ticket-a')

    const result = await client.callTool({ name: 'sa_secret_store', arguments: { name: 'API_TOKEN', value: 'v' } })

    expect(result.isError).toBe(true)
    expect(result.content).toMatchObject([{ type: 'text', text: '同名密钥已存在：API_TOKEN' }])
  })

  it('records an AI secret request bound to the ticket', async () => {
    const engine = stubEngine()
    const calls: { ticketId: string; name: string; why: string }[] = []
    const { url } = await serve(engine, undefined, {
      secretRequest: (ticketId, input) => { calls.push({ ticketId, ...input }); return { ok: true } },
    })
    const client = await clientFor(url, 'ticket-a')

    const result = await client.callTool({ name: 'sa_secret_request', arguments: { name: 'DEPLOY_KEY', why: 'deploy the fix' } })

    expect(calls).toEqual([{ ticketId: 'TK-A', name: 'DEPLOY_KEY', why: 'deploy the fix' }])
    expect(result.isError).toBeFalsy()
  })

  it('redacts report text before it reaches the Engine', async () => {
    const engine = stubEngine()
    const { url } = await serve(engine, undefined, { redact: text => text.split('super-secret-value').join('***') })
    const client = await clientFor(url, 'ticket-a')

    await client.callTool({
      name: 'sa_report',
      arguments: { state: 'progress', summary: 'used super-secret-value', question: 'is super-secret-value right?' },
    })

    expect(engine.report).toHaveBeenCalledWith('TK-A', {
      state: 'progress', summary: 'used ***', question: 'is *** right?',
    })
  })

  it('acknowledges through the acknowledgement reply purpose', async () => {
    const engine = stubEngine()
    engine.reply.mockReturnValue({ id: 'reply-1', status: 'pending', reused: false })
    const { url } = await serve(engine)
    const client = await clientFor(url, 'ticket-a')

    await client.callTool({ name: 'sa_ack', arguments: { trigger_id: 'trigger-1', text: 'On it.' } })

    expect(engine.reply).toHaveBeenCalledWith({ purpose: 'acknowledgement', ticketId: 'TK-A', triggerId: 'trigger-1', text: 'On it.' })
  })
})
