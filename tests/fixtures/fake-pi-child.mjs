// Fake `pi -p --mode json` child for tests/collab-extension.spec.ts. The message is everything after `--`.
//   FAKE_CHILD_LOG=<path>  append one JSON line per run: agent, token, args, start and end times
// The message decides the behaviour: `SLEEP=<ms>` (default 150), `FAIL` exits 2, `BUDGET` ends on a 402 model error.
// Otherwise it answers `<agent>:<message>` in one assistant message.
import { appendFileSync } from 'node:fs'

const args = process.argv.slice(2)
const at = args.indexOf('--')
const message = at >= 0 ? args.slice(at + 1).join(' ') : ''
const agent = process.env.SA_AGENT ?? ''
const sleep = Number(/SLEEP=(\d+)/.exec(message)?.[1] ?? 150)
const start = Date.now()
const send = record => process.stdout.write(`${JSON.stringify(record)}\n`)
const log = extra => {
  if (!process.env.FAKE_CHILD_LOG) return
  appendFileSync(process.env.FAKE_CHILD_LOG, `${JSON.stringify({
    agent, token: process.env.SA_TICKET_TOKEN ?? '', mcp: process.env.SA_MCP_URL ?? null,
    secret: process.env.SOME_SECRET ?? null, args, message, start, end: Date.now(), ...extra,
  })}\n`)
}

process.on('SIGTERM', () => { log({ killed: true }); process.exit(143) })
send({ type: 'agent_start' })
send({ type: 'tool_execution_start', toolCallId: 'c1', toolName: 'read', args: { path: '.' } })
setTimeout(() => {
  if (message.includes('FAIL')) {
    log({})
    process.stderr.write('boom: child failed\n')
    process.exit(2)
  }
  if (message.includes('BUDGET')) {
    send({ type: 'message_end', message: { role: 'assistant', content: [], stopReason: 'error', errorMessage: '402 budget_exhausted: This ticket has used its budget' } })
  } else {
    send({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: `${agent}:${message}` }], stopReason: 'stop' } })
  }
  send({ type: 'agent_settled', aborted: false })
  log({})
  process.exit(0)
}, sleep)
