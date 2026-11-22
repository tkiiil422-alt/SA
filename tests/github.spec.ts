/**
 * The GitHub client and the worker's `sa_github_pr` tool.
 *
 * `fetch` is faked everywhere, so no test touches api.github.com. The token is asserted to travel only in the
 * Authorization header and never to appear in a message, a tool result, a stored link or an outbox row.
 */
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { GithubClient } from '../src/admin/github.ts'
import { TicketLinks } from '../src/admin/links.ts'
import { Effects } from '../src/effects/effects.ts'
import { Outbox } from '../src/outbox/outbox.ts'
import { createWorkerMcpServer, type WorkerEngine } from '../src/mcp/worker-server.ts'

const TOKEN = 'ghp_very_secret_token_123456'
const cleanups: (() => Promise<void> | void)[] = []

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!()
})

interface Call { url: string; method: string; authorization: string; body?: unknown }

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

/** A fetch that answers from a route table and records every call. */
function fakeFetch(routes: Record<string, (call: Call) => Response>): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = []
  const impl = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    const headers = new Headers(init?.headers)
    const call: Call = {
      url,
      method: (init?.method ?? 'GET').toUpperCase(),
      authorization: headers.get('authorization') ?? '',
      ...(typeof init?.body === 'string' ? { body: JSON.parse(init.body) as unknown } : {}),
    }
    calls.push(call)
    const path = new URL(url).pathname
    const handler = routes[path]
    return handler ? handler(call) : jsonResponse(404, { message: 'Not Found' })
  }) as typeof fetch
  return { fetch: impl, calls }
}

function client(fetchImpl: typeof fetch, repos = ['owner/repo']): GithubClient {
  return new GithubClient({ apiBase: 'https://api.github.test', token: TOKEN, repos, fetch: fetchImpl })
}

describe('GithubClient', () => {
  it('reports the login and each whitelisted repository push permission', async () => {
    const { fetch: fetchImpl, calls } = fakeFetch({
      '/user': () => jsonResponse(200, { login: 'octocat' }),
      '/repos/owner/repo': () => jsonResponse(200, { full_name: 'owner/repo', permissions: { push: true } }),
      '/repos/owner/readonly': () => jsonResponse(200, { full_name: 'owner/readonly', permissions: { push: false } }),
    })
    const result = await client(fetchImpl, ['owner/repo', 'owner/readonly']).testConnection()

    expect(result).toMatchObject({
      ok: true,
      login: 'octocat',
      repos: [
        { fullName: 'owner/repo', push: true },
        { fullName: 'owner/readonly', push: false },
      ],
    })
    expect(result.message).toContain('没有推送权限')
    expect(calls.every(call => call.authorization === `Bearer ${TOKEN}`)).toBe(true)
    expect(JSON.stringify(result)).not.toContain(TOKEN)
  })

  it('turns a rejected token into a Chinese message without the token', async () => {
    const { fetch: fetchImpl } = fakeFetch({
      '/user': () => jsonResponse(401, { message: `Bad credentials for ${TOKEN}` }),
    })
    const result = await client(fetchImpl).testConnection()

    expect(result.ok).toBe(false)
    expect(result.message).toContain('401')
    expect(result.message).not.toContain(TOKEN)
    expect(JSON.stringify(result)).not.toContain(TOKEN)
  })

  it('refuses a repository outside the whitelist without calling GitHub', async () => {
    const { fetch: fetchImpl, calls } = fakeFetch({})
    const result = await client(fetchImpl, ['owner/repo']).createPullRequest({
      repo: 'evil/repo', head: 'feature', base: 'main', title: 'Title', body: 'Body',
    })

    expect(result).toMatchObject({ ok: false })
    expect(result.ok === false ? result.message : '').toContain('白名单')
    expect(calls).toHaveLength(0)
  })

  it('creates a pull request with the documented body and returns its URL and number', async () => {
    const { fetch: fetchImpl, calls } = fakeFetch({
      '/repos/owner/repo/pulls': () => jsonResponse(201, {
        html_url: 'https://github.com/owner/repo/pull/7',
        number: 7,
      }),
    })
    const result = await client(fetchImpl, ['owner/repo']).createPullRequest({
      repo: 'owner/repo', head: 'feature', base: 'main', title: 'Fix the typo', body: 'It fixes a typo.',
    })

    expect(result).toEqual({ ok: true, url: 'https://github.com/owner/repo/pull/7', number: 7 })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.method).toBe('POST')
    expect(calls[0]!.authorization).toBe(`Bearer ${TOKEN}`)
    expect(calls[0]!.body).toEqual({ head: 'feature', base: 'main', title: 'Fix the typo', body: 'It fixes a typo.' })
  })

  it('never echoes the token from a GitHub error body', async () => {
    const { fetch: fetchImpl } = fakeFetch({
      '/repos/owner/repo/pulls': () => jsonResponse(403, { message: `token ${TOKEN} cannot push` }),
    })
    const result = await client(fetchImpl, ['owner/repo']).createPullRequest({
      repo: 'owner/repo', head: 'feature', base: 'main', title: 'Title', body: 'Body',
    })

    expect(result.ok).toBe(false)
    expect(result.ok === false ? result.message : '').toContain('403')
    expect(result.ok === false ? result.message : '').not.toContain(TOKEN)
  })
})

const stubEngine = (): WorkerEngine => ({
  report: vi.fn(),
  reply: vi.fn(),
  handback: vi.fn(),
  markUnrelated: vi.fn(),
  followForContext: vi.fn(),
})

describe('sa_github_pr MCP tool', () => {
  it('stores the link on the ticket and sends the PR URL to its channel', async () => {
    const db = new DatabaseSync(':memory:')
    const effects = new Effects(db)
    const outbox = new Outbox({ db, effects })
    const links = new TicketLinks({ db })
    const { fetch: fetchImpl, calls } = fakeFetch({
      '/repos/owner/repo/pulls': () => jsonResponse(201, {
        html_url: 'https://github.com/owner/repo/pull/9',
        number: 9,
      }),
    })
    const github = new GithubClient({ apiBase: 'https://api.github.test', token: TOKEN, repos: ['owner/repo'], fetch: fetchImpl })
    const server = createWorkerMcpServer({
      engine: stubEngine(),
      authorize: token => token === 'ticket-a' ? { ticketId: 'TK-A' } : undefined,
      githubPr: async (ticketId, input) => {
        const result = await github.createPullRequest({ ...input, base: input.base ?? 'main' })
        if (!result.ok) return result
        links.add(ticketId, { kind: 'pr', url: result.url, title: input.title })
        outbox.send({
          id: `github-pr-${ticketId}-${result.number}`,
          channel: { source: 'email', thread: 'root@example', address: { messageId: '<m1>' } },
          text: `PR：${result.url}`,
          kind: 'notice',
          ticketId,
        })
        return result
      },
    })
    const { port } = await server.listen()
    cleanups.push(() => server.close())
    cleanups.push(() => db.close())
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
      requestInit: { headers: { authorization: 'Bearer ticket-a' } },
    })
    const mcp = new Client({ name: 'github-test', version: '1.0.0' })
    await mcp.connect(transport)
    cleanups.push(() => mcp.close())

    const result = await mcp.callTool({
      name: 'sa_github_pr',
      arguments: { repo: 'owner/repo', head: 'feature', title: 'Fix', body: 'Body' },
    })
    const text = (result.content as { type: string; text: string }[])[0]!.text
    const payload = JSON.parse(text) as { created: boolean; url: string; number: number }

    expect(payload).toEqual({ created: true, url: 'https://github.com/owner/repo/pull/9', number: 9 })
    expect(links.list('TK-A')).toEqual([{ kind: 'pr', url: 'https://github.com/owner/repo/pull/9', title: 'Fix' }])
    expect(outbox.messagesForTicket('TK-A').map(message => message.text)).toEqual(['PR：https://github.com/owner/repo/pull/9'])
    expect(JSON.stringify(outbox.messagesForTicket('TK-A'))).not.toContain(TOKEN)
    // The base omitted by the worker was filled from the configured default.
    expect(calls[0]!.body).toMatchObject({ head: 'feature', base: 'main' })
    expect(text).not.toContain(TOKEN)
  })

  it('reports a whitelist refusal to the worker without storing anything', async () => {
    const db = new DatabaseSync(':memory:')
    const links = new TicketLinks({ db })
    const { fetch: fetchImpl } = fakeFetch({})
    const github = new GithubClient({ apiBase: 'https://api.github.test', token: TOKEN, repos: ['owner/repo'], fetch: fetchImpl })
    const server = createWorkerMcpServer({
      engine: stubEngine(),
      authorize: token => token === 'ticket-a' ? { ticketId: 'TK-A' } : undefined,
      githubPr: async (ticketId, input) => {
        const result = await github.createPullRequest({ ...input, base: input.base ?? 'main' })
        if (result.ok) links.add(ticketId, { kind: 'pr', url: result.url, title: input.title })
        return result
      },
    })
    const { port } = await server.listen()
    cleanups.push(() => server.close())
    cleanups.push(() => db.close())
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
      requestInit: { headers: { authorization: 'Bearer ticket-a' } },
    })
    const mcp = new Client({ name: 'github-test', version: '1.0.0' })
    await mcp.connect(transport)
    cleanups.push(() => mcp.close())

    const result = await mcp.callTool({
      name: 'sa_github_pr',
      arguments: { repo: 'evil/repo', head: 'feature', title: 'Fix', body: 'Body' },
    })

    expect(result.isError).toBe(true)
    expect(JSON.stringify(result)).toContain('白名单')
    expect(links.list('TK-A')).toEqual([])
  })
})
