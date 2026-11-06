/**
 * Subprocess client for the Pi coding agent's RPC mode.
 *
 * The child speaks strict JSONL: one JSON record per LF-terminated line on
 * stdout, commands as JSON lines on stdin. stdout is decoded as UTF-8 and split
 * only on LF (never with `readline`, which also splits on U+2028/U+2029).
 * stderr is diagnostics only and is kept as a bounded tail for error reports.
 *
 * The launch command is fully configurable so the same client can drive a local
 * `pi --mode rpc` process or the same command wrapped in a container runtime.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'

export type StreamingBehavior = 'steer' | 'followUp'
export type PromptDisposition = 'started' | 'queued' | 'handled'
export type QueuedInputDisposition = 'queued' | 'handled'
export type PiRpcErrorCode = 'not_started' | 'exited' | 'timeout' | 'command_failed' | 'write_failed' | 'closed'

/** Image content in the shape the RPC protocol expects for prompt/steer/follow_up. */
export interface ImageContent {
  type?: 'image'
  data: string
  mimeType: string
}

/** Any command record sent on stdin. Fields beyond `type` are command specific. */
export interface PiCommand {
  type: string
  [field: string]: unknown
}

/** A `response` record read from stdout. */
export interface PiResponse {
  type: 'response'
  id?: string
  command: string
  success: boolean
  data?: unknown
  error?: string
}

/** A non-response stdout record (agent, message, tool, queue, compaction, retry, ...). */
export type PiEvent = { type: string } & Record<string, unknown>

export type PiEventListener = (event: PiEvent) => void

export interface PiProcessExit {
  code: number | null
  signal: NodeJS.Signals | null
  /** Last lines written to stderr, most recent last. */
  stderr: readonly string[]
}

export type PiExitListener = (exit: PiProcessExit) => void

/** The subset of `get_state` data this client promises to hand back. */
export interface PiSessionState {
  model?: unknown
  thinkingLevel?: string
  isStreaming: boolean
  isCompacting: boolean
  steeringMode: 'all' | 'one-at-a-time'
  followUpMode: 'all' | 'one-at-a-time'
  sessionFile?: string
  sessionId: string
  sessionName?: string
  autoCompactionEnabled: boolean
  messageCount: number
  pendingMessageCount: number
}

export interface PiRpcClientOptions {
  /** Executable to launch, e.g. `pi`, `node`, or `podman`. */
  command: string
  /** Arguments in launch order. Nothing is added implicitly. */
  args: string[]
  cwd?: string
  /** Extra environment variables merged over `process.env`. */
  env?: Record<string, string>
  /** Deadline for each command response. Default: 30s. */
  requestTimeoutMs?: number
}

export interface PromptOptions {
  images?: readonly ImageContent[]
  streamingBehavior?: StreamingBehavior
}

export interface PromptAndWaitOptions extends PromptOptions {
  /** Deadline for `agent_settled`. Default: 60s. */
  timeoutMs?: number
}

export interface PromptAndWaitResult {
  response: PiResponse
  disposition: PromptDisposition
  /** Every non-response event observed from before the prompt was sent to `agent_settled`. */
  events: PiEvent[]
}

export interface CloseOptions {
  /** Time allowed for each shutdown step (stdin EOF, then SIGTERM, then SIGKILL). Default: 2s. */
  graceMs?: number
}

export class PiRpcError extends Error {
  readonly code: PiRpcErrorCode
  /** The failed response when the error came from a command response. */
  readonly response: PiResponse | undefined

  constructor(message: string, code: PiRpcErrorCode, response?: PiResponse) {
    super(message)
    this.name = 'PiRpcError'
    this.code = code
    this.response = response
  }
}

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000
const DEFAULT_SETTLE_TIMEOUT_MS = 60_000
const DEFAULT_CLOSE_GRACE_MS = 2_000
const STDERR_TAIL_LINES = 20
const STDERR_TEXT_LIMIT = 32_768

interface PendingRequest {
  resolve: (response: PiResponse) => void
  reject: (error: PiRpcError) => void
  timer: NodeJS.Timeout
  command: string
}

export class PiRpcClient {
  private readonly options: PiRpcClientOptions
  private readonly requestTimeoutMs: number

  private child: ChildProcess | null = null
  /** Children whose stdio streams have closed (ChildProcess `close` fired). */
  private readonly closedChildren = new WeakSet<ChildProcess>()
  private started = false
  private closing = false
  private exited = false
  private closePromise: Promise<void> | null = null

  private stdoutDecoder = new StringDecoder('utf8')
  private stdoutBuffer = ''
  private stderrText = ''

  private requestSeq = 0
  private readonly pending = new Map<string, PendingRequest>()
  private readonly eventListeners = new Set<PiEventListener>()
  private readonly exitListeners = new Set<PiExitListener>()
  private readonly settleWaiters = new Set<(error: PiRpcError) => void>()

  /** Serializes stdin writes so command order is preserved and `drain` is honored. */
  private writeChain: Promise<void> = Promise.resolve()

  private exitError: PiRpcError | null = null

  constructor(options: PiRpcClientOptions) {
    this.options = options
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
  }

  /** The child process id while it is running. */
  get pid(): number | undefined {
    return this.child?.pid
  }

  /** True between a successful `start()` and the child exiting or `close()` finishing. */
  get isRunning(): boolean {
    return this.child !== null && this.started && !this.exited && !this.closing
  }

  /** Launch the child process. Resolves once it has spawned. */
  async start(): Promise<void> {
    if (this.child !== null) throw new PiRpcError('Pi RPC client is already started', 'not_started')

    this.started = false
    this.closing = false
    this.exited = false
    this.exitError = null
    this.closePromise = null
    this.stderrText = ''
    this.stdoutBuffer = ''
    this.stdoutDecoder = new StringDecoder('utf8')
    this.writeChain = Promise.resolve()

    const child = spawn(this.options.command, this.options.args, {
      cwd: this.options.cwd,
      env: { ...process.env, ...this.options.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    this.child = child

    child.stdout?.on('data', (chunk: Buffer) => {
      if (this.child !== child) return
      this.consumeStdoutText(this.stdoutDecoder.write(chunk))
    })
    child.stdout?.on('end', () => {
      if (this.child !== child) return
      // Flush a multi-byte tail, but drop any record that is not LF-terminated:
      // protocol records are complete lines.
      this.consumeStdoutText(this.stdoutDecoder.end())
      this.stdoutBuffer = ''
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      if (this.child !== child) return
      this.consumeStderr(chunk)
    })
    child.stdin?.on('error', (error: Error) => {
      if (this.child !== child) return
      this.handleStdinError(error)
    })
    // `close` fires after `exit` and after every stdio stream has closed, so
    // records already written by the child (e.g. a final agent_settled) are
    // dispatched before pending work is rejected. Using `exit` here can drop
    // the last record of a child that exits immediately after writing it.
    child.once('close', (code, signal) => {
      this.closedChildren.add(child)
      if (this.child !== child) return
      this.handleExit(code, signal)
    })

    await new Promise<void>((resolve, reject) => {
      const onSpawn = (): void => {
        child.off('error', onSpawnError)
        resolve()
      }
      const onSpawnError = (error: Error): void => {
        child.off('spawn', onSpawn)
        if (this.child === child) this.child = null
        reject(new PiRpcError(`Failed to start Pi RPC process "${this.options.command}": ${error.message}`, 'exited'))
      }
      child.once('spawn', onSpawn)
      child.once('error', onSpawnError)
    })

    child.on('error', (error: Error) => {
      if (this.child !== child) return
      this.handleProcessError(error)
    })
    this.started = true
  }

  /** Send one command and resolve with its correlated response. Failed responses throw. */
  async sendCommand(command: PiCommand): Promise<PiResponse> {
    if (this.exitError !== null) throw this.exitError
    if (!this.started || this.child === null) throw new PiRpcError('Pi RPC client is not started', 'not_started')

    const id = `req_${++this.requestSeq}`
    const line = `${JSON.stringify({ ...command, id })}\n`

    const responsePromise = new Promise<PiResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new PiRpcError(`Timed out after ${this.requestTimeoutMs}ms waiting for a response to "${command.type}"`, 'timeout'))
      }, this.requestTimeoutMs)
      this.pending.set(id, { resolve, reject, timer, command: command.type })
    })

    void this.enqueueWrite(line).catch((error: unknown) => {
      const pending = this.pending.get(id)
      if (pending === undefined) return
      this.pending.delete(id)
      clearTimeout(pending.timer)
      const message = error instanceof Error ? error.message : String(error)
      pending.reject(new PiRpcError(message, 'write_failed'))
    })

    const response = await responsePromise
    if (!response.success) {
      throw new PiRpcError(response.error ?? `Pi command "${response.command}" failed`, 'command_failed', response)
    }
    return response
  }

  prompt(message: string, options: PromptOptions = {}): Promise<PromptDisposition> {
    return this.sendPromptCommand(message, options).then(readDisposition)
  }

  steer(message: string, images?: readonly ImageContent[]): Promise<QueuedInputDisposition> {
    const command: PiCommand = { type: 'steer', message }
    if (images !== undefined) command.images = images
    return this.sendCommand(command).then(readQueuedDisposition)
  }

  followUp(message: string, images?: readonly ImageContent[]): Promise<QueuedInputDisposition> {
    const command: PiCommand = { type: 'follow_up', message }
    if (images !== undefined) command.images = images
    return this.sendCommand(command).then(readQueuedDisposition)
  }

  /** Abort the current run; resolves when the session has become idle. */
  async abort(): Promise<void> {
    await this.sendCommand({ type: 'abort' })
  }

  async getState(): Promise<PiSessionState> {
    const response = await this.sendCommand({ type: 'get_state' })
    if (!isRecord(response.data)) {
      throw new PiRpcError('Malformed response to "get_state": expected an object in data', 'command_failed', response)
    }
    // Trust boundary: the record shape is the wire contract; only the fields
    // this client consumes are checked above.
    return response.data as unknown as PiSessionState
  }

  /** Subscribe to every non-response stdout record. Returns an unsubscribe function. */
  onEvent(listener: PiEventListener): () => void {
    this.eventListeners.add(listener)
    return () => {
      this.eventListeners.delete(listener)
    }
  }

  /** Subscribe to unexpected child exits. Returns an unsubscribe function. */
  onExit(listener: PiExitListener): () => void {
    this.exitListeners.add(listener)
    return () => {
      this.exitListeners.delete(listener)
    }
  }

  /**
   * Wait for the next `agent_settled` record.
   *
   * `agent_end` is not enough: retries, compaction recovery, steering, and
   * follow-up work can still continue after it. Only `agent_settled` means Pi
   * will not continue automatically.
   */
  async waitForSettled(timeoutMs: number = DEFAULT_SETTLE_TIMEOUT_MS): Promise<void> {
    if (this.exitError !== null) throw this.exitError
    if (!this.started || this.child === null) throw new PiRpcError('Pi RPC client is not running', 'not_started')

    await new Promise<void>((resolve, reject) => {
      let done = false
      let timer: NodeJS.Timeout | undefined
      let unsubscribe: (() => void) | undefined
      const onFailure = (error: PiRpcError): void => finish(error)
      const finish = (error?: PiRpcError): void => {
        if (done) return
        done = true
        if (timer !== undefined) clearTimeout(timer)
        unsubscribe?.()
        this.settleWaiters.delete(onFailure)
        if (error === undefined) resolve()
        else reject(error)
      }
      timer = setTimeout(
        () => finish(new PiRpcError(`Timed out after ${timeoutMs}ms waiting for agent_settled`, 'timeout')),
        timeoutMs,
      )
      unsubscribe = this.onEvent(event => {
        if (event.type === 'agent_settled') finish()
      })
      this.settleWaiters.add(onFailure)
    })
  }

  /**
   * Send a prompt and wait until Pi will not continue automatically.
   *
   * The event listener is installed before the prompt is sent so a fast run
   * cannot be missed. A `"handled"` disposition means no run started, so the
   * method returns immediately without waiting for `agent_settled`.
   */
  async promptAndWait(message: string, options: PromptAndWaitOptions = {}): Promise<PromptAndWaitResult> {
    const events: PiEvent[] = []
    let settled = false
    const unsubscribe = this.onEvent(event => {
      events.push(event)
      if (event.type === 'agent_settled') settled = true
    })

    try {
      const response = await this.sendPromptCommand(message, options)
      const disposition = readDisposition(response)
      if (disposition !== 'handled' && !settled) {
        await this.waitForSettled(options.timeoutMs ?? DEFAULT_SETTLE_TIMEOUT_MS)
      }
      return { response, disposition, events }
    } finally {
      unsubscribe()
    }
  }

  /**
   * Shut the child down in order: close stdin, wait `graceMs`, then SIGTERM,
   * wait `graceMs`, then SIGKILL, and wait once more before returning. If the
   * child never reports exit, `close` still returns; pending work is rejected.
   */
  close(options: CloseOptions = {}): Promise<void> {
    const existing = this.closePromise
    if (existing !== null) return existing
    const promise = this.performClose(options.graceMs ?? DEFAULT_CLOSE_GRACE_MS)
    this.closePromise = promise
    return promise
  }

  /** Everything the child wrote to stderr so far (bounded). */
  getStderr(): string {
    return this.stderrText
  }

  private sendPromptCommand(message: string, options: PromptOptions): Promise<PiResponse> {
    const command: PiCommand = { type: 'prompt', message }
    if (options.images !== undefined) command.images = options.images
    if (options.streamingBehavior !== undefined) command.streamingBehavior = options.streamingBehavior
    return this.sendCommand(command)
  }

  private async performClose(graceMs: number): Promise<void> {
    const child = this.child
    if (child === null) {
      this.started = false
      return
    }

    this.closing = true

    const stdin = child.stdin
    if (stdin !== null && !stdin.destroyed) {
      try {
        stdin.end()
      } catch {
        // Already gone; escalation below still applies.
      }
    }
    if (await this.waitForExit(child, graceMs)) {
      this.finishClose(child)
      return
    }

    this.killChild(child, 'SIGTERM')
    if (await this.waitForExit(child, graceMs)) {
      this.finishClose(child)
      return
    }

    this.killChild(child, 'SIGKILL')
    await this.waitForExit(child, graceMs)

    // Reject anything still waiting: a child that survived SIGKILL must not
    // leave callers hanging forever.
    this.failAll(new PiRpcError('Pi RPC client closed while requests were pending', 'closed'))
    this.finishClose(child)
  }

  /**
   * Wait until the child's stdio streams have closed. This is the same event
   * `handleExit` uses, so a command's final output is never rejected early.
   * A child that never closes its streams is bounded by the caller's timeout.
   */
  private waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
    if (this.closedChildren.has(child)) return Promise.resolve(true)
    return new Promise<boolean>(resolve => {
      let done = false
      const finish = (closed: boolean): void => {
        if (done) return
        done = true
        clearTimeout(timer)
        child.off('close', onClose)
        resolve(closed)
      }
      const onClose = (): void => finish(true)
      const timer = setTimeout(() => finish(false), timeoutMs)
      child.once('close', onClose)
    })
  }

  private killChild(child: ChildProcess, signal: NodeJS.Signals): void {
    try {
      child.kill(signal)
    } catch {
      // ESRCH (already gone) is fine.
    }
  }

  private finishClose(child: ChildProcess): void {
    if (this.child === child) this.child = null
    this.started = false
    this.exited = true
    this.stdoutBuffer = ''
    if (this.exitError === null) this.exitError = new PiRpcError('Pi RPC client closed', 'closed')
  }

  private enqueueWrite(line: string): Promise<void> {
    const write = this.writeChain.then(() => this.writeLine(line))
    // Keep the chain alive after a failed write; the caller sees the error.
    this.writeChain = write.catch(() => undefined)
    return write
  }

  private writeLine(line: string): Promise<void> {
    const stdin = this.child?.stdin
    if (stdin === null || stdin === undefined) return Promise.reject(new PiRpcError('Pi RPC stdin is not available', 'not_started'))
    if (stdin.destroyed || !stdin.writable) return Promise.reject(new PiRpcError('Pi RPC stdin is not writable', 'closed'))

    return new Promise<void>((resolve, reject) => {
      let done = false
      const cleanup = (): void => {
        stdin.off('drain', onDrain)
        stdin.off('error', onError)
        stdin.off('close', onClose)
      }
      const finish = (error?: Error): void => {
        if (done) return
        done = true
        cleanup()
        if (error === undefined) resolve()
        else reject(error)
      }
      const onDrain = (): void => finish()
      const onError = (error: Error): void => finish(error)
      const onClose = (): void => finish(new PiRpcError('Pi RPC stdin closed before the write completed', 'closed'))

      stdin.once('drain', onDrain)
      stdin.once('error', onError)
      stdin.once('close', onClose)
      try {
        if (stdin.write(line)) finish()
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  private handleStdinError(error: Error): void {
    if (this.exited || this.closing) return
    const wrapped = new PiRpcError(`Pi RPC stdin error: ${error.message}`, 'write_failed')
    this.exitError ??= wrapped
    this.failAll(wrapped)
  }

  private handleProcessError(error: Error): void {
    if (this.exited) return
    this.exited = true
    this.started = false
    const wrapped = new PiRpcError(`Pi RPC process error: ${error.message}`, 'exited')
    this.exitError = wrapped
    this.failAll(wrapped)
    if (!this.closing) this.emitExit({ code: null, signal: null, stderr: this.stderrTail() })
  }

  private handleExit(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.exited) return
    this.exited = true
    this.started = false
    const error = new PiRpcError(`Pi RPC process exited (code=${code ?? 'null'}, signal=${signal ?? 'null'})`, 'exited')
    this.exitError = error
    this.failAll(error)
    if (!this.closing) this.emitExit({ code, signal, stderr: this.stderrTail() })
  }

  private emitExit(exit: PiProcessExit): void {
    for (const listener of [...this.exitListeners]) {
      try {
        listener(exit)
      } catch {
        // A listener must not break stream or shutdown handling.
      }
    }
  }

  private failAll(error: PiRpcError): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
    for (const waiter of [...this.settleWaiters]) waiter(error)
    this.settleWaiters.clear()
  }

  private consumeStdoutText(text: string): void {
    if (text.length === 0) return
    this.stdoutBuffer += text
    for (;;) {
      const index = this.stdoutBuffer.indexOf('\n')
      if (index === -1) return
      let line = this.stdoutBuffer.slice(0, index)
      this.stdoutBuffer = this.stdoutBuffer.slice(index + 1)
      if (line.endsWith('\r')) line = line.slice(0, -1)
      if (line.length > 0) this.handleRecord(line)
    }
  }

  private handleRecord(line: string): void {
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      // Non-JSON on stdout is not protocol data; ignore it rather than killing the stream.
      return
    }
    if (!isRecord(parsed)) return

    if (parsed.type === 'response') {
      const id = typeof parsed.id === 'string' ? parsed.id : undefined
      if (id === undefined) return
      const pending = this.pending.get(id)
      if (pending === undefined) return
      this.pending.delete(id)
      clearTimeout(pending.timer)
      // Trust boundary: `type: "response"` plus the correlated id is what the
      // protocol guarantees here; success/data are interpreted by the caller.
      pending.resolve(parsed as unknown as PiResponse)
      return
    }

    const event = parsed as PiEvent
    for (const listener of [...this.eventListeners]) {
      try {
        listener(event)
      } catch {
        // A listener must not break record dispatch for other listeners.
      }
    }
  }

  private consumeStderr(chunk: Buffer): void {
    this.stderrText += chunk.toString('utf8')
    if (this.stderrText.length > STDERR_TEXT_LIMIT) this.stderrText = this.stderrText.slice(-STDERR_TEXT_LIMIT)
  }

  private stderrTail(): string[] {
    return this.stderrText.split(/\r?\n/).filter(line => line.length > 0).slice(-STDERR_TAIL_LINES)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readDisposition(response: PiResponse): PromptDisposition {
  const data = response.data
  if (isRecord(data)) {
    const disposition = data.disposition
    if (disposition === 'started' || disposition === 'queued' || disposition === 'handled') return disposition
  }
  throw new PiRpcError(`Malformed response to "${response.command}": expected data.disposition`, 'command_failed', response)
}

function readQueuedDisposition(response: PiResponse): QueuedInputDisposition {
  const data = response.data
  if (isRecord(data)) {
    const disposition = data.disposition
    if (disposition === 'queued' || disposition === 'handled') return disposition
  }
  throw new PiRpcError(`Malformed response to "${response.command}": expected data.disposition`, 'command_failed', response)
}
