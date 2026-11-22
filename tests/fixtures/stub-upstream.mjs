// Stub DeepSeek-compatible upstream for verifying the containerised Pi -> model gateway -> worker MCP chain.
//
// Zero dependencies. Listens on 127.0.0.1:18080. Every POST body is appended to /tmp/stub-upstream.log as one JSON
// line: {"path":"...","authorization":"<raw header>","body":"<raw string>"}.
//
// Round 1 (the first request of this process, and no tool history in the body) answers with a tool call to
// mcp__superagent__sa_report; later rounds answer with the plain text "done". Streaming requests get SSE chunks in
// the OpenAI chat.completion.chunk shape.
import { createServer } from 'node:http'
import { appendFileSync } from 'node:fs'

const HOST = '127.0.0.1'
const PORT = 18080
const LOG = '/tmp/stub-upstream.log'
const MODEL = 'deepseek-flash'
const USAGE = {
  prompt_tokens: 10,
  completion_tokens: 2,
  total_tokens: 12,
  prompt_cache_hit_tokens: 8,
  prompt_cache_miss_tokens: 2,
}
const REPORT_ARGS = JSON.stringify({ state: 'ready', summary: 'stub upstream: 容器链路验证通过' })
const TOOL_NAME = 'mcp__superagent__sa_report'

let requests = 0

function logRequest(req, body) {
  const entry = {
    path: req.url ?? '/',
    authorization: req.headers.authorization ?? null,
    body: body.toString('utf8'),
  }
  appendFileSync(LOG, `${JSON.stringify(entry)}\n`)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', chunk => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

/** First request of this process, unless the conversation already carries a tool result / assistant tool call. */
function wantsToolCall(index, body) {
  try {
    const parsed = JSON.parse(body.toString('utf8'))
    const messages = Array.isArray(parsed.messages) ? parsed.messages : []
    if (messages.some(message => message && message.role === 'tool')) return false
    if (messages.some(message => message && message.role === 'assistant'
      && Array.isArray(message.tool_calls) && message.tool_calls.length > 0)) return false
  } catch {
    // A non-JSON body cannot carry tool history.
  }
  return index === 0
}

function sseChunk(delta, finishReason, usage) {
  const payload = {
    id: 'stub',
    object: 'chat.completion.chunk',
    created: 0,
    model: MODEL,
    choices: [{ index: 0, delta, finish_reason: finishReason ?? null }],
  }
  if (usage) payload.usage = usage
  return `data: ${JSON.stringify(payload)}\n\n`
}

function streamResponse(res, toolCall) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    'x-request-id': 'stub',
  })
  // The first frame carries the role, as Pi's OpenAI-compatible layer expects.
  res.write(sseChunk({ role: 'assistant', content: '' }, null))
  if (toolCall) {
    res.write(sseChunk({
      tool_calls: [{
        index: 0,
        id: 'call_1',
        type: 'function',
        function: { name: TOOL_NAME, arguments: REPORT_ARGS },
      }],
    }, null))
    res.write(sseChunk({}, 'tool_calls', USAGE))
  } else {
    res.write(sseChunk({ content: 'done' }, null))
    res.write(sseChunk({}, 'stop', USAGE))
  }
  // Usage-only tail chunk, then the terminator.
  res.write(`data: ${JSON.stringify({
    id: 'stub', object: 'chat.completion.chunk', created: 0, model: MODEL, choices: [], usage: USAGE,
  })}\n\n`)
  res.write('data: [DONE]\n\n')
  res.end()
}

function jsonResponse(res, toolCall) {
  const message = toolCall
    ? {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: TOOL_NAME, arguments: REPORT_ARGS } }],
      }
    : { role: 'assistant', content: 'done' }
  const payload = {
    id: 'stub',
    object: 'chat.completion',
    created: 0,
    model: MODEL,
    choices: [{ index: 0, message, finish_reason: toolCall ? 'tool_calls' : 'stop' }],
    usage: USAGE,
  }
  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(payload))
}

const server = createServer((req, res) => {
  if (req.method !== 'POST') {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('not found')
    return
  }
  void readBody(req).then(body => {
    const index = requests
    requests += 1
    logRequest(req, body)
    let stream = false
    try {
      stream = JSON.parse(body.toString('utf8')).stream === true
    } catch {
      // Treat an unparsable body as non-streaming.
    }
    const toolCall = wantsToolCall(index, body)
    console.log(`stub-upstream: ${req.url} #${index} stream=${stream} toolCall=${toolCall}`)
    if (stream) streamResponse(res, toolCall)
    else jsonResponse(res, toolCall)
  }).catch(error => {
    console.error(`stub-upstream: request failed: ${error instanceof Error ? error.message : String(error)}`)
    if (!res.headersSent) res.writeHead(500)
    res.end()
  })
})

server.listen(PORT, HOST, () => {
  console.log(`stub-upstream listening on http://${HOST}:${PORT}`)
})
