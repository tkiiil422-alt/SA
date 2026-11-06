/**
 * HTTP server for the admin console.
 *
 * It hands each request to the API first, then to the static handler, and answers 404 itself. The default bind address is
 * loopback: the public entry point is the host's reverse proxy, and the control-style ports must never be exposed.
 * `close()` also drops keep-alive connections so a restart does not wait on idle clients.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

export interface AdminServerOptions {
  /** Returns true when it handled the request (including its own 404 for unknown `/api/*` routes). */
  api: (req: IncomingMessage, res: ServerResponse) => Promise<boolean>
  /** Returns true when it handled the request (a file or its own 404). */
  staticHandler: (req: IncomingMessage, res: ServerResponse) => boolean
  /** Defaults to `127.0.0.1`; only the reverse proxy may listen publicly. */
  host?: string
  /** Defaults to 8787; tests pass 0 for an ephemeral port. */
  port?: number
  /** Optional routes outside `/api` (such as the Feishu callback). Returns true when it handled the request. */
  callbacks?: (req: IncomingMessage, res: ServerResponse) => Promise<boolean>
}

export interface AdminServer {
  listen(): Promise<{ port: number }>
  close(): Promise<void>
}

function sendNotFound(res: ServerResponse): void {
  if (res.headersSent) {
    if (!res.writableEnded) res.destroy()
    return
  }
  const payload = JSON.stringify({ error: 'not_found', message: '没有这个地址。' })
  res.writeHead(404, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(Buffer.byteLength(payload)),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'content-security-policy': "default-src 'self'; style-src 'self' 'unsafe-inline'",
  })
  res.end(payload)
}

export function createAdminServer(options: AdminServerOptions): AdminServer {
  const { api, staticHandler, host = '127.0.0.1', port = 8787, callbacks } = options
  let listening = false

  const dispatch = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (callbacks && await callbacks(req, res)) return
    if (await api(req, res)) return
    if (staticHandler(req, res)) return
    sendNotFound(res)
  }

  const server = createServer((req, res) => {
    void dispatch(req, res).catch(() => {
      if (res.headersSent) {
        if (!res.writableEnded) res.destroy()
        return
      }
      const payload = JSON.stringify({ error: 'internal', message: '后台处理请求时出错了，请稍后重试。' })
      res.writeHead(500, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': String(Buffer.byteLength(payload)),
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        'x-frame-options': 'DENY',
        'content-security-policy': "default-src 'self'; style-src 'self' 'unsafe-inline'",
      })
      res.end(payload)
    })
  })

  return {
    listen: () => new Promise((resolve, reject) => {
      const onError = (error: Error): void => reject(error)
      server.once('error', onError)
      server.listen(port, host, () => {
        server.off('error', onError)
        listening = true
        resolve({ port: (server.address() as AddressInfo).port })
      })
    }),
    close: () => new Promise(resolve => {
      if (!listening) {
        resolve()
        return
      }
      listening = false
      server.closeAllConnections()
      server.close(() => resolve())
    }),
  }
}
