/**
 * `sa`: the command-line client of a running superagentd.
 *
 * The daemon writes its control URL to `<stateDir>/control.json`. The CLI finds it from `SA_STATE_DIR`, defaulting to
 * `.superagent` under the current directory, so it must run where the daemon was started (or with that variable set).
 *
 * Every request carries the CLI token: `SA_TOKEN` when set, else `<stateDir>/cli-token`, which the daemon writes. The
 * worker containers never mount the state directory, so a worker cannot read the token to call the control interface.
 */
import { createHash } from 'node:crypto'
import { closeSync, openSync, readFileSync, readSync, statSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import type { AskResult, Overview, TicketSummary, TicketView } from '../control/server.ts'

const stateDir = resolve(process.env.SA_STATE_DIR ?? '.superagent')
const controlFile = join(stateDir, 'control.json')
const tokenFile = join(stateDir, 'cli-token')
const DEFAULT_WAIT_MS = 120_000
const POLL_MS = 100
/** Scales the upload retry and realign waits. Production uses 1; the CLI tests set it low to keep retries fast. */
const retryScale = (() => {
  const value = Number(process.env.SA_RETRY_SCALE ?? '1')
  return Number.isFinite(value) && value >= 0 ? value : 1
})()

const sleep = (ms: number): Promise<void> => new Promise(resolveSleep => setTimeout(resolveSleep, ms))

function cliToken(): string | undefined {
  const fromEnv = process.env.SA_TOKEN?.trim()
  if (fromEnv) return fromEnv
  try {
    const value = readFileSync(tokenFile, 'utf8').trim()
    return value || undefined
  } catch {
    // No token file: an unauthenticated daemon (tests only) still accepts the request.
    return undefined
  }
}

const token = cliToken()

function controlFileValue(): Record<string, unknown> {
  let value: unknown
  try {
    value = JSON.parse(readFileSync(controlFile, 'utf8'))
  } catch {
    throw new Error(`superagentd is not running: ${controlFile} is missing (set SA_STATE_DIR to its state directory)`)
  }
  if (typeof value !== 'object' || value === null) throw new Error(`Invalid control file: ${controlFile}`)
  return value as Record<string, unknown>
}

function controlUrl(): string {
  const url = controlFileValue().url
  if (typeof url !== 'string') throw new Error(`Invalid control file: ${controlFile}`)
  return url
}

/** The admin API base; project uploads use it because the control route only serves ticket commands. */
function adminUrl(): string {
  const url = controlFileValue().adminUrl
  if (typeof url !== 'string') throw new Error(`Invalid control file: ${controlFile}`)
  return url
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers: Record<string, string> = { ...(init?.headers as Record<string, string> | undefined) }
  if (token) headers.authorization = `Bearer ${token}`
  const response = await fetch(`${controlUrl()}${path}`, { ...init, headers })
  const text = await response.text()
  let body: unknown
  try {
    body = text ? JSON.parse(text) : undefined
  } catch {
    throw new Error(`The control interface returned invalid JSON (HTTP ${response.status})`)
  }
  if (!response.ok) {
    const record = typeof body === 'object' && body !== null ? body as Record<string, unknown> : {}
    const message = typeof record.message === 'string'
      ? record.message
      : typeof record.error === 'string' ? record.error : `HTTP ${response.status}`
    throw new Error(`The control interface refused the request: ${message}`)
  }
  return body as T
}

const finished = (view: TicketView): boolean => view.status === 'ended'
  || view.latestReport?.state === 'ready'
  || (view.stage.stage === 'person'
    && (view.stage.action === 'blocked' || view.stage.action === 'failed'
      || view.stage.action === 'answer' || view.stage.action === 'review'))

function printView(view: TicketView): void {
  for (const message of view.messages) if (message.kind === 'acknowledgement') console.log(`ack: ${message.text}`)
  for (const message of view.messages) if (message.kind === 'reply') console.log(`result: ${message.text}`)
  if (!view.messages.some(message => message.kind === 'reply') && view.latestReport) console.log(`report: ${view.latestReport.summary}`)
  if (view.attention) console.log(`question: ${view.attention.question}`)
  console.log(`status: ${view.status}${view.ended ? ` (${view.ended.outcome})` : ''}`)
}

async function ask(args: string[]): Promise<void> {
  let wait = false
  let model: string | undefined
  let timeoutMs = DEFAULT_WAIT_MS
  const words: string[] = []
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!
    if (arg === '--wait') { wait = true; continue }
    if (arg === '--model') {
      model = args[index + 1]
      if (!model) throw new Error('--model needs provider/model')
      index += 1
      continue
    }
    if (arg.startsWith('--model=')) { model = arg.slice('--model='.length); continue }
    // `deploy/README.md` documents `--source cli`; the CLI is that Source, so the flag is accepted and ignored.
    if (arg === '--source') { index += 1; continue }
    if (arg.startsWith('--source=')) continue
    if (arg === '--timeout') {
      const value = Number(args[index + 1])
      if (!Number.isFinite(value) || value <= 0) throw new Error('--timeout needs a positive number of milliseconds')
      timeoutMs = value
      index += 1
      continue
    }
    words.push(arg)
  }
  const text = words.join(' ').trim()
  if (!text) throw new Error('Usage: sa ask "<text>" [--wait] [--timeout <ms>] [--source <name>] [--model <provider/model>]')

  const result = await request<AskResult>('/ask', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(model === undefined ? { text } : { text, model }),
  })
  if (!result.ticketId) {
    console.log(`ignored: ${result.decision ?? 'no ticket'} (thread ${result.threadKey})`)
    return
  }
  if (!wait) {
    console.log(`ticket: ${result.ticketId}`)
    console.log(`thread: ${result.threadKey}`)
    return
  }
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const view = await request<TicketView>(`/tickets/${encodeURIComponent(result.ticketId)}`)
    if (finished(view)) { printView(view); return }
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ticket ${result.ticketId}`)
    await sleep(POLL_MS)
  }
}

async function action(path: string, body: Record<string, unknown> = {}): Promise<void> {
  await request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

async function stop(args: string[]): Promise<void> {
  const [id, ...words] = args
  if (!id) throw new Error('Usage: sa stop <id> [reason]')
  const reason = words.join(' ').trim()
  await action(`/tickets/${encodeURIComponent(id)}/stop`, reason ? { reason } : {})
  console.log(`stopped: ${id}`)
}

async function retry(args: string[]): Promise<void> {
  const [id] = args
  if (!id) throw new Error('Usage: sa retry <id>')
  await action(`/tickets/${encodeURIComponent(id)}/retry`)
  console.log(`retried: ${id}`)
}

async function remove(args: string[]): Promise<void> {
  let id: string | undefined
  let deleteWorkspace = true
  let force = false
  for (const arg of args) {
    if (arg === '--keep-workspace') { deleteWorkspace = false; continue }
    if (arg === '--force') { force = true; continue }
    if (id !== undefined) throw new Error(`Usage: sa delete <id> [--keep-workspace] [--force] (unexpected "${arg}")`)
    id = arg
  }
  if (!id) throw new Error('Usage: sa delete <id> [--keep-workspace] [--force]')
  const result = await request<{ freedBytes?: number }>(`/tickets/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ deleteWorkspace, force }),
  })
  console.log(`deleted: ${id} (freed ${result.freedBytes ?? 0} bytes)`)
}

async function answer(args: string[]): Promise<void> {
  const [id, ...words] = args
  const text = words.join(' ').trim()
  if (!id || !text) throw new Error('Usage: sa answer <id> "<text>"')
  await action(`/tickets/${encodeURIComponent(id)}/reply`, { text })
  console.log(`answered: ${id}`)
}

async function overview(): Promise<void> {
  const data = await request<Overview>('/overview')
  console.log(`open: ${data.open}`)
  if (!data.needsPerson.length) { console.log('no tickets need a person'); return }
  for (const ticket of data.needsPerson) {
    const stage = ticket.stage.stage === 'person' ? `${ticket.stage.stage}/${ticket.stage.action}` : ticket.stage.stage
    console.log(`${ticket.id}\t${stage}\t${ticket.title}`)
    if (ticket.question) console.log(`question: ${ticket.question}`)
  }
}

async function list(): Promise<void> {
  const { tickets } = await request<{ tickets: TicketSummary[] }>('/tickets')
  if (!tickets.length) { console.log('no tickets'); return }
  for (const ticket of tickets) {
    const stage = ticket.stage.stage === 'person' ? `${ticket.stage.stage}/${ticket.stage.action}` : ticket.stage.stage
    console.log(`${ticket.id}\t${ticket.status}\t${stage}\t${ticket.title}`)
  }
}

async function show(id: string): Promise<void> {
  const view = await request<TicketView>(`/tickets/${encodeURIComponent(id)}`)
  console.log(JSON.stringify(view, null, 2))
}

// --- Projects ----------------------------------------------------------------------------------------------------

async function adminRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = { ...(init.headers as Record<string, string> | undefined) }
  if (token) headers.authorization = `Bearer ${token}`
  const response = await fetch(`${adminUrl()}/api${path}`, { ...init, headers })
  const text = await response.text()
  let body: unknown
  try {
    body = text ? JSON.parse(text) : undefined
  } catch {
    throw new Error(`The admin interface returned invalid JSON (HTTP ${response.status})`)
  }
  if (!response.ok) {
    const record = typeof body === 'object' && body !== null ? body as Record<string, unknown> : {}
    const message = typeof record.message === 'string' ? record.message : `HTTP ${response.status}`
    throw new Error(message)
  }
  return body as T
}

const CHUNK_SIZE = 8 * 1024 * 1024
const UPLOAD_RETRIES = 5
/** Consecutive 409s that report the same committed offset before the upload is declared stuck. */
const CONFLICT_LIMIT = 5
/** Gateway and restart statuses are transient; 500 is a server bug, so it is not retried. */
const RETRY_STATUSES = new Set([502, 503, 504])

const progressLine = (text: string): void => {
  process.stderr.write(`\r${text}\x1b[K`)
}

/**
 * One chunk. Network errors and 502/503/504 are retried with exponential backoff. After the last retry a 5xx Response
 * is returned so the caller reports the server's message. A 409 is also returned to the caller to realign.
 */
async function putChunk(uploadId: string, offset: number, buffer: Buffer, sha256: string): Promise<Response> {
  const backoff = (attempt: number): Promise<void> => sleep(Math.min(8_000, 500 * 2 ** attempt) * retryScale)
  for (let attempt = 0; ; attempt += 1) {
    let response: Response
    try {
      response = await fetch(`${adminUrl()}/api/uploads/${encodeURIComponent(uploadId)}?offset=${offset}`, {
        method: 'PUT',
        headers: {
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          'content-type': 'application/octet-stream',
          'x-sa-request': '1',
          'x-chunk-sha256': sha256,
        },
        body: buffer,
      })
    } catch (error) {
      if (attempt >= UPLOAD_RETRIES) throw error
      await backoff(attempt)
      continue
    }
    if (!RETRY_STATUSES.has(response.status) || attempt >= UPLOAD_RETRIES) return response
    await response.arrayBuffer()
    await backoff(attempt)
  }
}

async function projectUpload(args: string[]): Promise<void> {
  let file: string | undefined
  let projectName: string | undefined
  let resumeId: string | undefined
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!
    if (arg === '--name') { projectName = args[index + 1]; index += 1; continue }
    if (arg.startsWith('--name=')) { projectName = arg.slice('--name='.length); continue }
    if (arg === '--upload') { resumeId = args[index + 1]; index += 1; continue }
    if (arg.startsWith('--upload=')) { resumeId = arg.slice('--upload='.length); continue }
    if (file !== undefined) throw new Error(`Usage: sa project upload <file> [--name X] [--upload <id>] (unexpected "${arg}")`)
    file = arg
  }
  if (!file) throw new Error('Usage: sa project upload <file> [--name X] [--upload <id>]')
  const info = statSync(file)
  const fileName = basename(file)
  let uploadId = resumeId
  let offset = 0
  // Consecutive 409s that report the same committed offset; the server is not advancing.
  let stalledReceived: number | undefined
  let stalledCount = 0
  if (uploadId === undefined) {
    const created = await adminRequest<{ uploadId: string }>('/uploads', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: fileName, size: info.size }),
    })
    uploadId = created.uploadId
    console.log(`upload: ${uploadId}`)
  } else {
    const existing = await adminRequest<{ name: string; size: number; received: number }>(`/uploads/${encodeURIComponent(uploadId)}`)
    if (existing.size !== info.size || existing.name !== fileName) {
      throw new Error(`Upload ${uploadId} was for ${existing.name} (${existing.size} bytes), not ${fileName} (${info.size} bytes).`)
    }
    offset = existing.received
    console.log(`upload: ${uploadId} (resume at ${offset})`)
  }

  const fd = openSync(file, 'r')
  try {
    while (offset < info.size) {
      const length = Math.min(CHUNK_SIZE, info.size - offset)
      const buffer = Buffer.allocUnsafe(length)
      const read = readSync(fd, buffer, 0, length, offset)
      if (read !== length) throw new Error(`Could not read ${file} at ${offset}`)
      const sha256 = createHash('sha256').update(buffer).digest('hex')
      const response = await putChunk(uploadId, offset, buffer, sha256)
      if (response.status === 409) {
        const body = await response.json() as { received?: unknown }
        const received = typeof body.received === 'number' ? body.received : offset
        await sleep(300 * retryScale)
        if (received === stalledReceived) {
          stalledCount += 1
        } else {
          stalledReceived = received
          stalledCount = 1
        }
        if (stalledCount >= CONFLICT_LIMIT) {
          throw new Error(`上传卡住了：服务端一直停在 ${received} 字节，可能有另一处正在上传同一个文件。`)
        }
        offset = received
        continue
      }
      if (!response.ok) {
        const text = await response.text()
        let message = text
        try {
          const parsed = JSON.parse(text) as { message?: unknown }
          if (typeof parsed.message === 'string') message = parsed.message
        } catch {
          // Keep the raw body.
        }
        throw new Error(message || `HTTP ${response.status}`)
      }
      const body = await response.json() as { received?: unknown }
      offset = typeof body.received === 'number' ? body.received : offset + length
      const percent = Math.min(100, Math.floor((offset / info.size) * 100))
      progressLine(`上传 ${percent}% (${offset} / ${info.size})`)
    }
  } finally {
    closeSync(fd)
  }
  progressLine('')

  const finished = await adminRequest<{ projectId: string }>(`/uploads/${encodeURIComponent(uploadId)}/finish`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(projectName === undefined ? {} : { projectName }),
  })
  console.log(`project: ${finished.projectId}`)

  // Wait for the background extraction so the command's exit code says whether the project is usable.
  for (;;) {
    const project = await adminRequest<{
      status: string
      files?: number
      bytes?: number
      error?: string
      progress?: { done: number; total: number }
    }>(`/projects/${encodeURIComponent(finished.projectId)}`)
    if (project.status === 'extracting') {
      const progress = project.progress
      progressLine(progress && progress.total > 0 ? `解压 ${progress.done} / ${progress.total}` : '解压中…')
      await sleep(1_000)
      continue
    }
    progressLine('')
    if (project.status === 'ready') {
      console.log(`ready: ${project.files ?? 0} files, ${project.bytes ?? 0} bytes`)
    } else {
      console.error(`failed: ${project.error ?? '解压失败'}`)
      process.exitCode = 1
    }
    return
  }
}

async function projectList(): Promise<void> {
  const { items } = await adminRequest<{ items: { id: string; name: string; status: string; files: number; bytes: number; createdAt: string }[] }>('/projects')
  if (items.length === 0) { console.log('no projects'); return }
  for (const project of items) {
    console.log(`${project.id}\t${project.status}\t${project.files}\t${project.bytes}\t${project.createdAt}\t${project.name}`)
  }
}

async function projectRemove(args: string[]): Promise<void> {
  const [id] = args
  if (!id) throw new Error('Usage: sa project rm <id>')
  await adminRequest(`/projects/${encodeURIComponent(id)}`, { method: 'DELETE' })
  console.log(`deleted: ${id}`)
}

async function projectCommand(args: string[]): Promise<void> {
  const [sub, ...rest] = args
  if (sub === 'upload') await projectUpload(rest)
  else if (sub === 'list') await projectList()
  else if (sub === 'rm') await projectRemove(rest)
  else throw new Error('Usage: sa project upload <file> [--name X] [--upload <id>] | sa project list | sa project rm <id>')
}

// --- Councils -----------------------------------------------------------------------------------------------------

interface CouncilTurnView {
  roleId: string
  name: string
  status: 'pending' | 'running' | 'done' | 'failed'
  text: string
  ms: number
  costUsd: number
}

interface CouncilDetailView {
  id: string
  mode: 'brief' | 'decision'
  status: 'running' | 'done' | 'failed' | 'cancelled'
  phase: string
  topic: string
  brief?: string
  error?: string
  costUsd: number
  rounds: { n: number; turns: CouncilTurnView[] }[]
}

const COUNCIL_WAIT_MS = 10 * 60 * 1000
const COUNCIL_POLL_MS = 1_000

/** Poll one council, printing each finished speech once; returns the final view. */
async function watchCouncil(id: string): Promise<CouncilDetailView> {
  const seen = new Set<string>()
  let lastPhase = ''
  const deadline = Date.now() + COUNCIL_WAIT_MS
  for (;;) {
    const detail = await adminRequest<CouncilDetailView>(`/councils/${encodeURIComponent(id)}`)
    if (detail.phase !== lastPhase) {
      lastPhase = detail.phase
      console.log(`phase: ${detail.phase}`)
    }
    for (const round of detail.rounds) {
      for (const turn of round.turns) {
        const key = `${round.n}:${turn.roleId}`
        if (seen.has(key)) continue
        if (turn.status !== 'done' && turn.status !== 'failed') continue
        seen.add(key)
        const label = turn.status === 'done' ? '完成' : '失败'
        console.log(`第 ${round.n} 轮 · ${turn.name} · ${label} · ${turn.ms}ms · $${turn.costUsd.toFixed(6)}`)
      }
    }
    if (detail.status !== 'running') return detail
    if (Date.now() > deadline) throw new Error(`等待会商超时：${id}`)
    await sleep(COUNCIL_POLL_MS)
  }
}

function printCouncilOutcome(detail: CouncilDetailView): void {
  console.log(`status: ${detail.status}`)
  console.log(`cost: $${detail.costUsd.toFixed(6)}`)
  if (detail.error !== undefined) console.log(`error: ${detail.error}`)
}

async function councilNew(args: string[]): Promise<void> {
  let mode = 'brief'
  let projectId: string | undefined
  let ticketId: string | undefined
  let rounds: number | undefined
  const words: string[] = []
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!
    if (arg === '--mode') {
      mode = args[index + 1] ?? ''
      index += 1
      continue
    }
    if (arg.startsWith('--mode=')) { mode = arg.slice('--mode='.length); continue }
    if (arg === '--project') { projectId = args[index + 1]; index += 1; continue }
    if (arg.startsWith('--project=')) { projectId = arg.slice('--project='.length); continue }
    if (arg === '--ticket') { ticketId = args[index + 1]; index += 1; continue }
    if (arg.startsWith('--ticket=')) { ticketId = arg.slice('--ticket='.length); continue }
    if (arg === '--rounds') { rounds = Number(args[index + 1]); index += 1; continue }
    if (arg.startsWith('--rounds=')) { rounds = Number(arg.slice('--rounds='.length)); continue }
    words.push(arg)
  }
  const text = words.join(' ').trim()
  if (!text) throw new Error('Usage: sa council new "<text>" [--mode brief|decision] [--project <id>] [--ticket <id>] [--rounds n]')
  if (mode !== 'brief' && mode !== 'decision') throw new Error('Usage: --mode 只能是 brief 或 decision')
  if (rounds !== undefined && (!Number.isInteger(rounds) || rounds < 1 || rounds > 3)) throw new Error('Usage: --rounds 只能是 1、2 或 3')

  const created = await adminRequest<{ id: string }>('/councils', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      mode,
      text,
      ...(projectId === undefined ? {} : { projectId }),
      ...(ticketId === undefined ? {} : { ticketId }),
      ...(rounds === undefined ? {} : { rounds }),
    }),
  })
  console.log(`council: ${created.id}`)
  const detail = await watchCouncil(created.id)
  printCouncilOutcome(detail)
  if (detail.status === 'done' && detail.brief !== undefined) {
    console.log('')
    console.log(detail.brief)
  }
  if (detail.status === 'failed') process.exitCode = 1
}

async function councilShow(args: string[]): Promise<void> {
  const [id] = args
  if (!id) throw new Error('Usage: sa council show <id>')
  const detail = await adminRequest<CouncilDetailView>(`/councils/${encodeURIComponent(id)}`)
  if (detail.brief !== undefined && detail.brief.trim() !== '') {
    console.log(detail.brief)
    return
  }
  console.log(`status: ${detail.status}${detail.phase === '' ? '' : ` (${detail.phase})`}`)
  if (detail.error !== undefined) console.log(`error: ${detail.error}`)
  console.log('还没有任务书；等到会商完成后用 sa council show 查看。')
}

async function councilCommit(args: string[]): Promise<void> {
  const [id] = args
  if (!id) throw new Error('Usage: sa council commit <id>')
  const result = await adminRequest<{ ok: true; ticketId?: string; triggerId: string }>(`/councils/${encodeURIComponent(id)}/commit`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  })
  if (result.ticketId !== undefined) console.log(`ticket: ${result.ticketId}`)
  else console.log(`not created: ${result.triggerId}`)
}

async function councilRemove(args: string[]): Promise<void> {
  const [id] = args
  if (!id) throw new Error('Usage: sa council rm <id>')
  await adminRequest(`/councils/${encodeURIComponent(id)}`, { method: 'DELETE' })
  console.log(`deleted: ${id}`)
}

async function councilCommand(args: string[]): Promise<void> {
  const [sub, ...rest] = args
  if (sub === 'new') await councilNew(rest)
  else if (sub === 'show') await councilShow(rest)
  else if (sub === 'commit') await councilCommit(rest)
  else if (sub === 'rm') await councilRemove(rest)
  else throw new Error('Usage: sa council new "<text>" [--mode brief|decision] [--project <id>] [--ticket <id>] [--rounds n] | sa council show <id> | sa council commit <id> | sa council rm <id>')
}

const [command, ...rest] = process.argv.slice(2)
try {
  if (command === 'ask') await ask(rest)
  else if (command === 'tickets') await list()
  else if (command === 'ticket') {
    const id = rest[0]
    if (!id) throw new Error('Usage: sa ticket <id>')
    await show(id)
  } else if (command === 'stop') await stop(rest)
  else if (command === 'retry') await retry(rest)
  else if (command === 'answer') await answer(rest)
  else if (command === 'delete') await remove(rest)
  else if (command === 'overview') await overview()
  else if (command === 'project') await projectCommand(rest)
  else if (command === 'council') await councilCommand(rest)
  else {
    console.error('Usage: sa ask "<text>" [--wait] [--timeout <ms>] [--source <name>] [--model <provider/model>] | sa tickets | sa ticket <id>')
    console.error('       sa stop <id> [reason] | sa retry <id> | sa answer <id> "<text>" | sa delete <id> [--keep-workspace] [--force] | sa overview')
    console.error('       sa project upload <file> [--name X] [--upload <id>] | sa project list | sa project rm <id>')
    console.error('       sa council new "<text>" [--mode brief|decision] [--project <id>] [--ticket <id>] [--rounds n] | sa council show <id> | sa council commit <id> | sa council rm <id>')
    process.exitCode = 1
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}
