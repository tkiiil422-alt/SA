// Fake Pi RPC endpoint used by tests/pi-rpc.spec.ts.
//
// Reads JSONL commands on stdin and writes JSONL responses/events on stdout.
// It never parses stdin with readline so it has the same LF-only framing the
// real Pi uses. Environment switches simulate failure modes:
//
//   FAKE_PI_CRASH=1                 respond to prompt, emit agent_start, then exit(3)
//   FAKE_PI_IGNORE_STDIN_CLOSE=1    keep running after stdin EOF (forces SIGTERM/SIGKILL)
//   FAKE_PI_RUN_MS=<ms>             total duration of one simulated run (default 90)
//   FAKE_PI_LOG=<path>              append one JSON line per received prompt/steer/follow_up/abort
import { appendFileSync } from 'node:fs'

const crash = process.env.FAKE_PI_CRASH === '1'
const ignoreStdinClose = process.env.FAKE_PI_IGNORE_STDIN_CLOSE === '1'
// Respond, emit a whole settled run in one write, then exit immediately. Used
// to prove the last record is not lost when the child exits right after it.
const exitAfterSettled = process.env.FAKE_PI_EXIT_AFTER_SETTLED === '1'
const runMs = Number(process.env.FAKE_PI_RUN_MS ?? 90)
const crashExitCode = Number(process.env.FAKE_PI_CRASH_EXIT_CODE ?? 3)
// Report ready through the worker MCP endpoint after a prompt, then settle normally.
const reportReady = process.env.FAKE_PI_REPORT_READY === '1'
// Accept the prompt and stay alive without doing anything, for restart-recovery tests.
const hang = process.env.FAKE_PI_HANG === '1'

// U+2028 and U+2029 are valid inside JSON strings and must not split a record.
const deltas = ['first\u2028record', 'still\u2029one', 'third delta', 'last\u2028one']
const usage = { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }

let buffer = ''
let running = false
let stateCalls = 0
let timers = []

function send(record) {
  process.stdout.write(`${JSON.stringify(record)}\n`)
}

const logFile = process.env.FAKE_PI_LOG
function log(command) {
  if (!logFile) return
  try {
    appendFileSync(logFile, `${JSON.stringify({
      command: command.type,
      ...(typeof command.message === 'string' ? { message: command.message } : {}),
    })}\n`)
  } catch {
    // Diagnostics only; never break the protocol.
  }
}

function respond(id, command, data, error) {
  const record = { type: 'response', command, success: error === undefined }
  if (id !== undefined) record.id = id
  if (error !== undefined) record.error = error
  else if (data !== undefined) record.data = data
  send(record)
}

function schedule(callback, delayMs) {
  const timer = setTimeout(() => {
    timers = timers.filter(item => item !== timer)
    callback()
  }, delayMs)
  timers.push(timer)
}

function stopRun(aborted) {
  for (const timer of timers) clearTimeout(timer)
  timers = []
  if (!running) return
  send({ type: 'agent_end', messages: [], willRetry: false })
  send({ type: 'agent_settled', aborted })
  running = false
}

function startRun(id) {
  running = true
  respond(id, 'prompt', { disposition: 'started' })
  schedule(() => {
    send({ type: 'agent_start' })
    if (crash) {
      process.stderr.write('fake-pi: simulated crash during run\n')
      process.stderr.write('fake-pi: exiting before agent_settled\n')
      // Give stderr a chance to flush before exiting.
      setTimeout(() => process.exit(crashExitCode), 20)
      return
    }
    const step = Math.max(4, Math.floor(runMs / (deltas.length + 1)))
    deltas.forEach((delta, index) => {
      schedule(() => {
        send({ type: 'message_update', usage, assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta } })
      }, step * (index + 1))
    })
    schedule(() => {
      send({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: deltas.join('') }] } })
      send({ type: 'agent_end', messages: [], willRetry: false })
      send({ type: 'agent_settled', aborted: false })
      running = false
    }, step * (deltas.length + 1))
  }, 5)
}

function startAndExit(id) {
  running = true
  respond(id, 'prompt', { disposition: 'started' })
  const records = [
    { type: 'agent_start' },
    { type: 'message_update', usage, assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: deltas[0] } },
    { type: 'agent_end', messages: [], willRetry: false },
    { type: 'agent_settled', aborted: false },
  ]
  const payload = records.map(record => `${JSON.stringify(record)}\n`).join('')
  // The write callback runs once the payload has been handed to the OS, so
  // exiting here does not truncate the final records.
  process.stdout.write(payload, () => process.exit(0))
}

/** Connect to the worker MCP endpoint with the ticket token, report ready, then settle the run. */
async function reportReadyAndSettle(id, message) {
  running = true
  respond(id, 'prompt', { disposition: 'started' })
  let request = ''
  try {
    const parsed = JSON.parse(message)
    if (typeof parsed.request === 'string') request = parsed.request
  } catch {
    // A malformed brief still gets a report; the summary just says less.
  }
  try {
    const url = process.env.SA_MCP_URL
    const token = process.env.SA_TICKET_TOKEN
    if (!url || !token) throw new Error('SA_MCP_URL or SA_TICKET_TOKEN is missing')
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
    const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js')
    const transport = new StreamableHTTPClientTransport(new URL(url), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    })
    const client = new Client({ name: 'fake-pi', version: '1.0.0' })
    await client.connect(transport)
    await client.callTool({
      name: 'sa_report',
      arguments: { state: 'ready', summary: `done: ${Array.from(request).slice(0, 20).join('')}` },
    })
    await client.close()
  } catch (error) {
    process.stderr.write(`fake-pi: report failed: ${error instanceof Error ? error.message : String(error)}\n`)
  }
  send({ type: 'agent_start' })
  send({ type: 'agent_end', messages: [], willRetry: false })
  send({ type: 'agent_settled', aborted: false })
  running = false
}

function handle(command) {
  const id = typeof command.id === 'string' ? command.id : undefined
  if (command.type === 'prompt' || command.type === 'steer' || command.type === 'follow_up' || command.type === 'abort') log(command)
  switch (command.type) {
    case 'prompt':
      if (hang) {
        running = true
        respond(id, 'prompt', { disposition: 'started' })
        // FAKE_PI_BUSY_MS: keep the turn open but emit a step every N ms, like a long run that is still working.
        const busyMs = Number(process.env.FAKE_PI_BUSY_MS ?? 0)
        if (busyMs > 0) {
          setInterval(() => {
            send({ type: 'tool_execution_start', toolCallId: `busy-${Date.now()}`, toolName: 'bash', args: { command: 'sleep 1' } })
          }, busyMs)
        }
        return
      }
      if (reportReady) {
        void reportReadyAndSettle(id, command.message)
        return
      }
      if (exitAfterSettled) {
        startAndExit(id)
        return
      }
      if (running && command.streamingBehavior === undefined) {
        respond(id, 'prompt', undefined, 'Agent is already streaming; streamingBehavior is required')
        return
      }
      if (running) {
        respond(id, 'prompt', { disposition: 'queued' })
        return
      }
      startRun(id)
      return
    case 'steer':
      respond(id, 'steer', { disposition: 'queued' })
      return
    case 'follow_up':
      respond(id, 'follow_up', { disposition: 'queued' })
      return
    case 'abort':
      stopRun(true)
      respond(id, 'abort')
      return
    case 'get_state': {
      const data = {
        thinkingLevel: 'off',
        isStreaming: running,
        isCompacting: false,
        steeringMode: 'all',
        followUpMode: 'one-at-a-time',
        sessionId: 'fake-session',
        autoCompactionEnabled: false,
        messageCount: ++stateCalls,
        pendingMessageCount: 0,
      }
      const delayMs = Number(command.delayMs ?? 0)
      if (delayMs > 0) setTimeout(() => respond(id, 'get_state', data), delayMs)
      else respond(id, 'get_state', data)
      return
    }
    default:
      respond(id, command.type, undefined, `Unknown command: ${command.type}`)
  }
}

process.stdin.setEncoding('utf8')
process.stdin.on('data', chunk => {
  buffer += chunk
  for (;;) {
    const index = buffer.indexOf('\n')
    if (index === -1) return
    const line = buffer.slice(0, index).replace(/\r$/, '')
    buffer = buffer.slice(index + 1)
    if (line.length === 0) continue
    let command
    try {
      command = JSON.parse(line)
    } catch {
      send({ type: 'response', command: 'parse', success: false, error: 'Failed to parse command' })
      continue
    }
    handle(command)
  }
})

process.stdin.on('end', () => {
  if (ignoreStdinClose) return
  stopRun(false)
  setTimeout(() => process.exit(0), 5)
})

if (ignoreStdinClose) {
  // Keep the event loop alive after stdin EOF so the client has to signal us.
  setInterval(() => {}, 1000)
  // On POSIX a SIGTERM listener is ignored by default, which forces the client
  // to escalate to SIGKILL. Windows terminates on any signal, so this only
  // matters on non-Windows CI.
  if (process.platform !== 'win32') process.on('SIGTERM', () => {})
}
