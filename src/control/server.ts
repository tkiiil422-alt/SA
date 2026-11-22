/**
 * Local HTTP control interface of the daemon.
 *
 * It listens on 127.0.0.1 with an ephemeral port, which the runtime writes to `<stateDir>/control.json`; the `sa` CLI
 * reads that file. Routes: `POST /ask`, `GET /tickets`, `GET /tickets/:id`, the person's actions under
 * `POST /tickets/:id/{stop,retry,reply}`, `DELETE /tickets/:id`, and `GET /overview`.
 *
 * When a token is configured, every route requires `Authorization: Bearer <token>`; the worker containers share the
 * host's network namespace, so an unauthenticated control port would let a worker file tickets for itself.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { checkCliToken } from '../admin/auth.ts'
import { UserError } from '../core/errors.ts'
import type { TicketStage } from '../core/index.ts'
import type { StoredMessage } from '../outbox/outbox.ts'
import { InvalidModelError } from '../executor/pi-models.ts'

export interface AskResult {
  triggerId: string
  threadId: string
  threadKey: string
  ticketId?: string
  decision?: string
}

export interface TicketView {
  id: string
  title: string
  status: 'open' | 'ended'
  ended?: { at: string; by: string; outcome: string; reason?: string }
  stage: TicketStage
  latestReport?: { state: string; summary: string; at: string }
  /** The ticket's current question for a person (see `Ticket.attention`), which `sa ask --wait` prints. */
  attention?: { question: string; askedBy?: string }
  /** Whether a person may retry the ticket now, as `canRetry` decides in the domain. */
  canRetry: boolean
  /** The last failed input delivery, kept visible until a delivery succeeds. */
  delivery?: { error: string; at: string }
  messages: StoredMessage[]
}

export interface TicketSummary {
  id: string
  title: string
  status: 'open' | 'ended'
  stage: TicketStage
  updatedAt: string
}

/** One ticket a person has to act on, with the question it asked, when it is waiting for an answer. */
export interface OverviewTicket {
  id: string
  title: string
  stage: TicketStage
  question?: string
}

/** What a person must look at now, and how many tickets are open. */
export interface Overview {
  needsPerson: OverviewTicket[]
  open: number
}

export interface ControlHost {
  ask(text: string, opts?: { model?: string }): Promise<AskResult>
  ticket(id: string): TicketView | undefined
  tickets(): TicketSummary[]
  /** A person stops the ticket; `reason` is kept with the ending. */
  stop(id: string, reason?: string): void
  /** A person retries a ticket whose worker reported blocked or failed, or whose delivery failed. */
  retry(id: string): void
  /** A person's message on the ticket's original thread. */
  reply(id: string, text: string): void
  /** Delete a ticket with its files; `force` stops an open ticket first. */
  delete(id: string, options: { deleteWorkspace: boolean; force: boolean }): { freedBytes: number }
  overview(): Overview
}

export interface ControlServerOptions {
  /** Bearer token every route requires; when omitted, the server trusts any caller (tests only). */
  token?: string
}

export interface ControlServer {
  listen(): Promise<{ port: number }>
  close(): Promise<void>
}

const MAX_BODY = 1_000_000
const ACTION_ROUTE = /^\/tickets\/([^/]+)\/(stop|retry|reply)$/

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': String(Buffer.byteLength(payload)) })
  res.end(payload)
}

function readBody(req: IncomingMessage): Promise<string | undefined> {
  return new Promise(resolve => {
    const chunks: Buffer[] = []
    let size = 0
    let settled = false
    const finish = (value: string | undefined): void => {
      if (settled) return
      settled = true
      resolve(value)
    }
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY) {
        finish(undefined)
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => finish(Buffer.concat(chunks).toString('utf8')))
    req.on('error', () => finish(undefined))
    req.on('aborted', () => finish(undefined))
  })
}

const describe = (error: unknown): string => error instanceof Error ? error.message : String(error)

/** Whether the request declares a JSON body. A write route without it is refused before it reaches the host. */
function hasJsonContentType(req: IncomingMessage): boolean {
  const value = req.headers['content-type']
  return typeof value === 'string' && /^application\/json\b/i.test(value.trim())
}

/**
 * Runs one host action, mapping its failure to a response: a `UserError` is a missing (404) or refused (409) request, an
 * error with a numeric `status` keeps that status, and anything else is an internal failure.
 */
function runAction(res: ServerResponse, action: () => unknown): void {
  try {
    const body = action()
    sendJson(res, 200, body === undefined ? { ok: true } : body)
  } catch (error) {
    const status = error instanceof UserError
      ? (error.missing ? 404 : 409)
      : typeof error === 'object' && error !== null && typeof (error as { status?: unknown }).status === 'number'
        ? (error as { status: number }).status
        : undefined
    if (status === undefined) {
      console.error(`superagentd: control action failed: ${describe(error)}`)
      sendJson(res, 500, { error: 'control_failure', message: describe(error) })
      return
    }
    const code = error instanceof UserError
      ? error.code
      : typeof (error as { code?: unknown }).code === 'string'
        ? (error as { code: string }).code
        : 'refused'
    sendJson(res, status, { error: code, message: describe(error) })
  }
}

export function createControlServer(host: ControlHost, options: ControlServerOptions = {}): ControlServer {
  const expected = options.token
  const invalid = Symbol('invalid-body')

  /** The parsed body, `undefined` for an empty one, or `invalid` after a response already refused it. */
  const requireBody = async (req: IncomingMessage, res: ServerResponse): Promise<unknown | undefined | typeof invalid> => {
    if (!hasJsonContentType(req)) {
      sendJson(res, 415, { error: 'content_type_required', message: 'Write requests need Content-Type: application/json' })
      return invalid
    }
    const raw = await readBody(req)
    if (raw === undefined) { sendJson(res, 413, { error: 'body_too_large' }); return invalid }
    if (!raw.trim()) return undefined
    try {
      return JSON.parse(raw) as unknown
    } catch {
      sendJson(res, 400, { error: 'invalid_json' })
      return invalid
    }
  }

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    // The port is loopback-only, but worker containers share the host's network namespace (`--network=host`), so a worker
    // could otherwise reach every ticket. Every route, read or write, needs the token when one is configured.
    if (expected && !checkCliToken(expected, req.headers.authorization)) {
      sendJson(res, 401, { error: 'unauthorized' })
      return
    }
    const url = new URL(req.url ?? '/', 'http://control.invalid')
    if (req.method === 'POST' && url.pathname === '/ask') {
      const raw = await readBody(req)
      if (raw === undefined) { sendJson(res, 413, { error: 'body_too_large' }); return }
      let body: unknown
      try { body = JSON.parse(raw) } catch { sendJson(res, 400, { error: 'invalid_json' }); return }
      const text = typeof body === 'object' && body !== null && typeof (body as Record<string, unknown>).text === 'string'
        ? ((body as Record<string, unknown>).text as string).trim()
        : ''
      if (!text) { sendJson(res, 400, { error: 'text_required' }); return }
      const model = typeof body === 'object' && body !== null && typeof (body as Record<string, unknown>).model === 'string'
        ? ((body as Record<string, unknown>).model as string).trim()
        : ''
      try {
        sendJson(res, 200, await host.ask(text, model === '' ? undefined : { model }))
      } catch (error) {
        if (error instanceof InvalidModelError) {
          sendJson(res, 400, { error: 'invalid', message: error.message, issues: error.issues })
          return
        }
        throw error
      }
      return
    }
    if (req.method === 'GET' && url.pathname === '/tickets') {
      sendJson(res, 200, { tickets: host.tickets() })
      return
    }
    if (req.method === 'GET' && url.pathname === '/overview') {
      sendJson(res, 200, host.overview())
      return
    }
    const action = ACTION_ROUTE.exec(url.pathname)
    if (req.method === 'POST' && action) {
      const id = decodeURIComponent(action[1]!)
      const body = await requireBody(req, res)
      if (body === invalid) return
      const record = typeof body === 'object' && body !== null ? body as Record<string, unknown> : {}
      if (action[2] === 'stop') {
        const reason = typeof record.reason === 'string' && record.reason.trim() ? record.reason.trim() : undefined
        runAction(res, () => host.stop(id, reason))
        return
      }
      if (action[2] === 'retry') {
        runAction(res, () => host.retry(id))
        return
      }
      const text = typeof record.text === 'string' ? record.text.trim() : ''
      if (!text) { sendJson(res, 400, { error: 'text_required' }); return }
      runAction(res, () => host.reply(id, text))
      return
    }
    const match = /^\/tickets\/([^/]+)$/.exec(url.pathname)
    if (req.method === 'GET' && match) {
      const view = host.ticket(decodeURIComponent(match[1]!))
      if (!view) { sendJson(res, 404, { error: 'unknown_ticket' }); return }
      sendJson(res, 200, view)
      return
    }
    if (req.method === 'DELETE' && match) {
      const id = decodeURIComponent(match[1]!)
      let record: Record<string, unknown> = {}
      // The CLI sends a JSON body; a bare DELETE uses the defaults (delete workspace, do not force).
      if (hasJsonContentType(req)) {
        const body = await requireBody(req, res)
        if (body === invalid) return
        record = typeof body === 'object' && body !== null ? body as Record<string, unknown> : {}
      }
      runAction(res, () => host.delete(id, {
        deleteWorkspace: typeof record.deleteWorkspace === 'boolean' ? record.deleteWorkspace : true,
        force: record.force === true,
      }))
      return
    }
    sendJson(res, 404, { error: 'not_found' })
  }

  const server = createServer((req, res) => {
    void handle(req, res).catch(() => {
      if (!res.headersSent) sendJson(res, 500, { error: 'control_failure' })
      else if (!res.writableEnded) res.destroy()
    })
  })
  let listening = false

  return {
    listen: () => new Promise((resolve, reject) => {
      const onError = (error: Error): void => reject(error)
      server.once('error', onError)
      server.listen(0, '127.0.0.1', () => {
        server.off('error', onError)
        listening = true
        resolve({ port: (server.address() as AddressInfo).port })
      })
    }),
    close: () => new Promise(resolve => {
      if (!listening) { resolve(); return }
      listening = false
      server.closeAllConnections()
      server.close(() => resolve())
    }),
  }
}
