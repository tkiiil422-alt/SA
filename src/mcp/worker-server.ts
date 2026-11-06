/**
 * MCP endpoint for ticket workers: one local streamable HTTP server whose tools report to the domain Engine.
 *
 * A worker authenticates with the ticket token assigned to its ticket. The token alone identifies the ticket;
 * no tool accepts a ticket id, so a worker cannot act for another ticket. Tools are served statelessly: every
 * HTTP request builds a fresh MCP server bound to the ticket the request's token names.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { UserError } from '../core/index.ts'
import type { EngineForExecutor, ThreadRef, WorkerReport } from '../core/index.ts'

/** The Engine methods a worker's tools may use. */
export type WorkerEngine = Pick<EngineForExecutor, 'report' | 'handback' | 'markUnrelated' | 'followForContext' | 'reply'>

/** What a tool failure reports to the host, beside the generic text the worker receives. */
export interface WorkerToolError {
  tool: string
  ticketId: string
}

/** One AI store call, bound to the requesting ticket by the runtime. */
export interface WorkerSecretStoreInput {
  name: string
  value: string
  description?: string
}

/** One AI request for a secret, bound to the requesting ticket by the runtime. */
export interface WorkerSecretRequestInput {
  name: string
  why: string
}

export type WorkerSecretStoreResult = { ok: true; name: string } | { ok: false; message: string }
export type WorkerSecretRequestResult = { ok: true } | { ok: false; message: string }

/** One preview registration for a port the runtime allocated to this ticket. */
export interface WorkerPreviewInput {
  port: number
  title?: string
}

export type WorkerPreviewResult = { ok: true; url: string; path: string } | { ok: false; message: string }

/** One pull-request request from a worker; `base` is optional and the runtime supplies the configured default. */
export interface WorkerGithubPrInput {
  repo: string
  head: string
  base?: string
  title: string
  body: string
}

export type WorkerGithubPrResult = { ok: true; url: string; number: number } | { ok: false; message: string }

export interface WorkerMcpServerOptions {
  engine: WorkerEngine
  /** Resolves a bearer token to the ticket it belongs to; unknown or missing tokens never reach MCP handling. */
  authorize: (token: string) => { ticketId: string } | undefined
  /** Optional redaction applied to report text before the Engine stores it. Never receives secret names. */
  redact?: (text: string) => string
  /** Stores an AI-created secret; absent means the tool reports that storage is unavailable. */
  secretStore?: (ticketId: string, input: WorkerSecretStoreInput) => WorkerSecretStoreResult
  /** Records an AI request for an existing secret; absent means the tool reports that requests are unavailable. */
  secretRequest?: (ticketId: string, input: WorkerSecretRequestInput) => WorkerSecretRequestResult
  /** Publishes one of the ticket's allocated preview ports; absent means previews are unavailable. */
  preview?: (ticketId: string, input: WorkerPreviewInput) => WorkerPreviewResult
  /** Opens a pull request with the operator's GitHub token; absent means GitHub is unavailable. */
  githubPr?: (ticketId: string, input: WorkerGithubPrInput) => Promise<WorkerGithubPrResult>
  /** Interface to listen on. Default `127.0.0.1`; the endpoint is meant for local workers only. */
  host?: string
  /** Port to listen on. Default 0, which asks the OS for a free port. */
  port?: number
  /** Receives the details of an unexpected tool failure; the worker only sees a short generic error. */
  onError?: (error: unknown, context: WorkerToolError) => void
}

export interface WorkerMcpServer {
  listen(): Promise<{ port: number }>
  close(): Promise<void>
}

/** Table ordering of the tools: fixed so an upstream prompt cache can rely on it. New tools are appended. */
export const WORKER_TOOL_NAMES = [
  'sa_report', 'sa_ack', 'sa_handback', 'sa_thread_unrelated', 'sa_thread_follow', 'sa_secret_store', 'sa_secret_request',
  'sa_preview', 'sa_github_pr',
] as const

const SecretNameSchema = z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/, 'A secret name is an environment variable name.')
const SecretValueSchema = z.string().min(1).max(8192).describe('The secret value. It is never echoed back.')

const textResult = (text: string): CallToolResult => ({ content: [{ type: 'text', text }] })
const errorResult = (text: string): CallToolResult => ({ content: [{ type: 'text', text }], isError: true })

/** A failure a tool reports to the worker verbatim (for example "that name already exists"). */
class ToolFailure extends Error {}

/** The bearer token of an Authorization header, or undefined when the header is absent or malformed. */
function bearerToken(header: string | undefined): string | undefined {
  const match = /^Bearer[ \t]+(\S+)$/i.exec(header?.trim() ?? '')
  return match?.[1]
}

/** Validates a thread key (`<source>:<id>`) before it reaches the Engine. */
const ThreadKeySchema = z.string().min(3).refine(value => {
  const at = value.indexOf(':')
  return at > 0 && at < value.length - 1
}, 'A thread key is <source>:<id>, such as github:<number>')

const threadRef = (key: string): ThreadRef => {
  const at = key.indexOf(':')
  return { source: key.slice(0, at), id: key.slice(at + 1) }
}

const ReasonSchema = z.string().trim().min(1).max(300).describe('One sentence on why.')

/** Builds the tools bound to one ticket; nothing in their schemas may name a ticket. */
function createServerFor(options: WorkerMcpServerOptions, ticketId: string): McpServer {
  const { engine, onError, redact } = options
  const clean = (text: string): string => redact === undefined ? text : redact(text)
  const server = new McpServer({ name: 'superagent-worker', version: '0.1.0' })

  const run = async (tool: string, action: () => unknown): Promise<CallToolResult> => {
    try {
      const value = await action()
      return textResult(typeof value === 'string' ? value : JSON.stringify(value ?? null))
    } catch (error) {
      if (error instanceof UserError || error instanceof ToolFailure) return errorResult(error.message)
      onError?.(error, { tool, ticketId })
      return errorResult('The tool failed unexpectedly.')
    }
  }

  server.registerTool('sa_report', {
    description: 'Report this ticket\'s state: progress (work continues), waiting (waiting for a follow-up), ready (reviewed result with relevant checks passed), blocked (a person must unblock it), failed (the work cannot be completed), or dropped (nothing left to do). Use progress for internal updates; immediately after creating a PR, report progress with its PR number. One report may answer a person\'s earlier question (answer_to) and ask a new one (question) at the same time; only a ready result cannot carry a question.',
    inputSchema: z.strictObject({
      state: z.enum(['progress', 'waiting', 'ready', 'blocked', 'failed', 'dropped']).describe('The state the work is in.'),
      summary: z.string().min(1).describe('What was done, which checks ran, and any risks; keep it short.'),
      question: z.string().trim().min(1).max(1000).nullable().optional()
        .describe('A concrete question for a person; null clears the pending question, omitting it keeps it.'),
      asked_by: z.string().min(1).optional().describe('With question: the human message that raised it.'),
      answer_to: z.string().min(1).optional().describe('The human question this report answers; never ordinary progress.'),
    }),
  }, args => run('sa_report', () => {
    const report: WorkerReport = { state: args.state, summary: clean(args.summary) }
    if (args.question !== undefined) report.question = args.question === null ? null : clean(args.question)
    if (args.asked_by !== undefined) report.askedBy = clean(args.asked_by)
    if (args.answer_to !== undefined) report.answers = clean(args.answer_to)
    engine.report(ticketId, report)
    return { reported: true, state: args.state }
  }))

  server.registerTool('sa_ack', {
    description: 'Acknowledge one original human request before substantial work; the acknowledgement is posted as a reply to that message.',
    inputSchema: z.strictObject({
      trigger_id: z.string().min(1).describe('The human message being acknowledged.'),
      text: z.string().trim().min(1).describe('One short sentence naming the concrete change and intended result.'),
    }),
  }, args => run('sa_ack', () => {
    const reply = engine.reply({ purpose: 'acknowledgement', ticketId, triggerId: args.trigger_id, text: args.text })
    return { trigger_id: args.trigger_id, ...(reply ? { status: reply.status, reused: reply.reused } : {}) }
  }))

  server.registerTool('sa_handback', {
    description: 'Hand back a message that asks for work beyond this ticket or for another ticket, for a fresh assessment; once per message. queued is false while another ticket still decides it.',
    inputSchema: z.strictObject({
      trigger_id: z.string().min(1).describe('The message to hand back.'),
      reason: ReasonSchema.describe('One sentence on what it asks for beyond this ticket.'),
    }),
  }, args => run('sa_handback', () => ({
    trigger_id: args.trigger_id,
    queued: engine.handback(ticketId, args.trigger_id, args.reason),
  })))

  server.registerTool('sa_thread_unrelated', {
    description: 'Stop following a thread attached to this ticket that is not about it; the ticket\'s own threads and source threads cannot be dropped.',
    inputSchema: z.strictObject({
      thread: ThreadKeySchema.describe('The thread key, such as github:<number> or feishu:<chat>:<root>.'),
      reason: ReasonSchema.describe('One sentence on why the thread is not about this ticket.'),
    }),
  }, args => run('sa_thread_unrelated', () => {
    engine.markUnrelated(ticketId, args.thread, args.reason)
    return { removed: true, thread: args.thread }
  }))

  server.registerTool('sa_thread_follow', {
    description: 'Follow a related thread, such as an Issue or another PR, for context only.',
    inputSchema: z.strictObject({
      thread: ThreadKeySchema.describe('The thread key, such as github:<number>.'),
      reason: ReasonSchema.describe('One sentence on how it relates.'),
    }),
  }, args => run('sa_thread_follow', () => ({
    thread: args.thread,
    followed: engine.followForContext(ticketId, threadRef(args.thread)),
  })))

  server.registerTool('sa_secret_store', {
    description: 'Store a new secret in the operator\'s vault and grant it to this ticket for the next container start. Only a new name is accepted; an existing secret is never overwritten. The value is never echoed back.',
    inputSchema: z.strictObject({
      name: SecretNameSchema.describe('The environment variable name, such as API_TOKEN.'),
      value: SecretValueSchema,
      description: z.string().trim().max(300).optional().describe('What the secret is for.'),
    }),
  }, args => run('sa_secret_store', () => {
    const hook = options.secretStore
    if (hook === undefined) throw new ToolFailure('Secret storage is not available.')
    const result = hook(ticketId, {
      name: args.name,
      value: args.value,
      ...(args.description === undefined ? {} : { description: args.description }),
    })
    if (!result.ok) throw new ToolFailure(result.message)
    return { stored: true, name: result.name }
  }))

  server.registerTool('sa_secret_request', {
    description: 'Ask the operator to grant an existing secret to this ticket; it takes effect on the next container start. Use this instead of asking a person to paste the value.',
    inputSchema: z.strictObject({
      name: SecretNameSchema.describe('The environment variable name, such as API_TOKEN.'),
      why: z.string().trim().min(1).max(300).describe('One sentence on why this ticket needs it.'),
    }),
  }, args => run('sa_secret_request', () => {
    const hook = options.secretRequest
    if (hook === undefined) throw new ToolFailure('Secret requests are not available.')
    const result = hook(ticketId, { name: args.name, why: args.why })
    if (!result.ok) throw new ToolFailure(result.message)
    return { requested: true, name: args.name }
  }))

  server.registerTool('sa_preview', {
    description: 'Publish a web preview of an application running in this container. Bind the application to one of the ports in SA_PREVIEW_PORTS, then register that port here; the returned URL is publicly reachable while this ticket\'s container runs. After the container stops, the same URL serves the files in /workspace/output as a static copy (index.html for the root), so put a static build of the deliverable there.',
    inputSchema: z.strictObject({
      port: z.number().int().min(1024).max(65535).describe('One of the ports listed in SA_PREVIEW_PORTS.'),
      title: z.string().trim().min(1).max(60).optional().describe('A short name for the preview.'),
    }),
  }, args => run('sa_preview', () => {
    const hook = options.preview
    if (hook === undefined) throw new ToolFailure('Previews are not available.')
    const result = hook(ticketId, {
      port: args.port,
      ...(args.title === undefined ? {} : { title: args.title }),
    })
    if (!result.ok) throw new ToolFailure(result.message)
    return { published: true, url: result.url, path: result.path }
  }))

  server.registerTool('sa_github_pr', {
    description: 'Open a pull request in a whitelisted GitHub repository with the operator\'s token. Use the branch you pushed as head and the repository\'s base branch (or omit base for the configured default). The returned URL is also sent to this ticket\'s conversation.',
    inputSchema: z.strictObject({
      repo: z.string().min(3).max(200).describe('The repository as owner/repo; it must be on the operator\'s whitelist.'),
      head: z.string().min(1).max(200).describe('The branch that holds the changes.'),
      base: z.string().min(1).max(200).optional().describe('The branch to merge into; defaults to the configured base.'),
      title: z.string().trim().min(1).max(200).describe('The pull request title.'),
      body: z.string().max(20_000).describe('The pull request description.'),
    }),
  }, args => run('sa_github_pr', async () => {
    const hook = options.githubPr
    if (hook === undefined) throw new ToolFailure('GitHub pull requests are not available.')
    const result = await hook(ticketId, {
      repo: args.repo,
      head: args.head,
      title: args.title,
      body: args.body,
      ...(args.base === undefined ? {} : { base: args.base }),
    })
    if (!result.ok) throw new ToolFailure(result.message)
    return { created: true, url: result.url, number: result.number }
  }))

  return server
}

const sendJson = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void => {
  res.writeHead(status, { 'content-type': 'application/json', ...headers })
  res.end(JSON.stringify(body))
}

/** Creates the local streamable HTTP endpoint; nothing listens until `listen()` is called. */
export function createWorkerMcpServer(options: WorkerMcpServerOptions): WorkerMcpServer {
  const { authorize, onError } = options
  const host = options.host ?? '127.0.0.1'
  const port = options.port ?? 0
  const active = new Set<{ server: McpServer; transport: StreamableHTTPServerTransport }>()
  let listening = false
  let closing = false

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const token = bearerToken(req.headers.authorization)
    const ticket = token === undefined ? undefined : authorize(token)
    if (!ticket) {
      sendJson(res, 401, { error: 'Unauthorized' }, { 'www-authenticate': 'Bearer' })
      return
    }
    // The endpoint is stateless: GET and DELETE have no stream or session to offer.
    if (req.method !== 'POST') {
      sendJson(res, 405, { jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null }, { allow: 'POST' })
      return
    }
    const server = createServerFor(options, ticket.ticketId)
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
    const entry = { server, transport }
    active.add(entry)
    const cleanup = (): void => {
      active.delete(entry)
      void transport.close().catch(() => undefined)
      void server.close().catch(() => undefined)
    }
    res.on('close', cleanup)
    try {
      await server.connect(transport)
      await transport.handleRequest(req, res)
    } catch (error) {
      onError?.(error, { tool: 'transport', ticketId: ticket.ticketId })
      if (!res.headersSent) sendJson(res, 500, { jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null })
      else if (!res.writableEnded) res.destroy()
    }
  }

  const server = createServer((req, res) => { void handle(req, res) })

  return {
    listen: () => new Promise((resolve, reject) => {
      if (listening) { reject(new Error('The worker MCP server is already listening')); return }
      if (closing) { reject(new Error('The worker MCP server is closed')); return }
      server.once('error', reject)
      server.listen(port, host, () => {
        server.off('error', reject)
        listening = true
        resolve({ port: (server.address() as AddressInfo).port })
      })
    }),
    close: async () => {
      if (closing) return
      closing = true
      for (const entry of active) {
        await entry.transport.close().catch(() => undefined)
        await entry.server.close().catch(() => undefined)
      }
      active.clear()
      if (!listening) return
      listening = false
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    },
  }
}
