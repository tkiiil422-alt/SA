/**
 * Pi 历史会话（session jsonl）的离线读取与分叉复制。
 *
 * 每张工单的 Pi 配置目录 `<piConfigRoot>/<ticketId>/` 下，Pi 会把对话写成
 * `sessions/<cwd 编码>/<时间戳>_<sessionId>.jsonl`（首行为 `{"type":"session","id","cwd","timestamp"}` 头，
 * 之后是 `model_change` / `message` 等条目）。这里只做纯文件解析，不启动容器，因此总控与控制台可以随时回顾
 * 一张工单（含已结束工单）里 Pi 上次具体做了什么，也能把旧会话复制给新工单，用 `pi --fork <id>` 继承上下文。
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'

/** 单个会话文件允许读取的最大字节数；超出时只读尾部，避免超长会话撑爆内存。 */
const MAX_SESSION_BYTES = 40 * 1024 * 1024
const SESSION_FILE = /^[0-9TZ:._-]+_([0-9A-Za-z._-]+)\.jsonl$/

export interface PiSessionFileInfo {
  file: string
  sessionId: string
  bytes: number
  modifiedAt: string
}

export interface PiSessionMessageView {
  id: string
  role: 'user' | 'assistant' | 'tool'
  at: string
  text: string
  /** assistant 消息里调用的工具名（含简要参数）。 */
  tools?: string[]
  /** tool 消息对应的工具名（若能识别）。 */
  toolName?: string
}

export interface PiSessionSummary {
  file: string
  sessionId: string
  cwd?: string
  startedAt?: string
  bytes: number
  entries: number
  messages: number
  userMessages: number
  assistantMessages: number
  toolCalls: number
  models: string[]
  /** 只读到文件尾部时为 true（前半段历史未解析）。 */
  partial: boolean
}

export interface PiSessionView {
  summary: PiSessionSummary
  messages: PiSessionMessageView[]
}

const cut = (text: string, max: number): string => (text.length <= max ? text : `${text.slice(0, max)}…（已截断，共 ${text.length} 字）`)

/** 把 content（字符串或块数组）压平成纯文本，并收集 assistant 的工具调用。 */
function flatten(content: unknown): { text: string; tools: string[] } {
  if (typeof content === 'string') return { text: content, tools: [] }
  if (!Array.isArray(content)) return { text: '', tools: [] }
  const parts: string[] = []
  const tools: string[] = []
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue
    const item = block as Record<string, unknown>
    if (item.type === 'text' && typeof item.text === 'string') parts.push(item.text)
    else if (item.type === 'toolCall' && typeof item.name === 'string') {
      let brief = ''
      try {
        const args = item.arguments as Record<string, unknown> | undefined
        const first = args ? Object.values(args)[0] : undefined
        if (typeof first === 'string') brief = first.replace(/\s+/g, ' ').slice(0, 80)
      } catch { /* 参数不可读时只记录工具名 */ }
      tools.push(brief ? `${item.name}(${brief})` : item.name)
    }
  }
  return { text: parts.join('\n').trim(), tools }
}

/** 某张工单配置目录下的全部会话文件，最新的在前。目录不存在时返回空数组。 */
export function listPiSessionFiles(piConfigDir: string): PiSessionFileInfo[] {
  const root = join(piConfigDir, 'sessions')
  if (!existsSync(root)) return []
  const found: PiSessionFileInfo[] = []
  let groups: string[] = []
  try { groups = readdirSync(root, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name) } catch { return [] }
  for (const group of groups) {
    let names: string[] = []
    try { names = readdirSync(join(root, group)) } catch { continue }
    for (const name of names) {
      const match = SESSION_FILE.exec(name)
      if (!match) continue
      const file = join(root, group, name)
      try {
        const info = statSync(file)
        if (!info.isFile()) continue
        found.push({ file, sessionId: match[1]!, bytes: info.size, modifiedAt: info.mtime.toISOString() })
      } catch { /* 文件刚被删除，忽略 */ }
    }
  }
  // 最近修改的在前；修改时间相同时按文件名（以时间戳开头）倒序，保证结果稳定。
  return found.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt) || basename(b.file).localeCompare(basename(a.file)))
}

/** 读取并解析一个会话文件，返回统计摘要和最近 `limit` 条对话（system 消息与 thinking 不返回）。 */
export function readPiSession(
  file: string,
  opts: { limit?: number; maxChars?: number; includeTools?: boolean } = {},
): PiSessionView {
  const limit = Math.max(1, Math.min(200, opts.limit ?? 20))
  const maxChars = Math.max(80, Math.min(6000, opts.maxChars ?? 600))
  const includeTools = opts.includeTools === true
  const size = statSync(file).size
  let raw = readFileSync(file, 'utf8')
  let partial = false
  if (size > MAX_SESSION_BYTES) {
    raw = raw.slice(-MAX_SESSION_BYTES)
    raw = raw.slice(raw.indexOf('\n') + 1)
    partial = true
  }
  const summary: PiSessionSummary = {
    file: basename(file),
    sessionId: SESSION_FILE.exec(basename(file))?.[1] ?? '',
    bytes: size,
    entries: 0,
    messages: 0,
    userMessages: 0,
    assistantMessages: 0,
    toolCalls: 0,
    models: [],
    partial,
  }
  const models = new Set<string>()
  const messages: PiSessionMessageView[] = []
  const toolNames = new Map<string, string>()
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    let entry: Record<string, unknown>
    try { entry = JSON.parse(line) as Record<string, unknown> } catch { continue }
    if (entry.type === 'session') {
      if (typeof entry.id === 'string') summary.sessionId = entry.id
      if (typeof entry.cwd === 'string') summary.cwd = entry.cwd
      if (typeof entry.timestamp === 'string') summary.startedAt = entry.timestamp
      continue
    }
    summary.entries += 1
    if (entry.type === 'model_change' && typeof entry.modelId === 'string') {
      models.add(typeof entry.provider === 'string' ? `${entry.provider}/${entry.modelId}` : entry.modelId)
      continue
    }
    if (entry.type !== 'message' || typeof entry.message !== 'object' || entry.message === null) continue
    const message = entry.message as Record<string, unknown>
    const role = message.role
    const at = typeof entry.timestamp === 'string' ? entry.timestamp : ''
    const id = typeof entry.id === 'string' ? entry.id : ''
    const { text, tools } = flatten(message.content)
    if (role === 'user') {
      summary.messages += 1
      summary.userMessages += 1
      messages.push({ id, role: 'user', at, text: cut(text, maxChars) })
    } else if (role === 'assistant') {
      summary.messages += 1
      summary.assistantMessages += 1
      summary.toolCalls += tools.length
      if (!text && tools.length === 0) continue
      messages.push({ id, role: 'assistant', at, text: cut(text, maxChars), ...(tools.length ? { tools } : {}) })
      for (const block of Array.isArray(message.content) ? message.content : []) {
        const item = block as Record<string, unknown>
        if (item?.type === 'toolCall' && typeof item.id === 'string' && typeof item.name === 'string') toolNames.set(item.id, item.name)
      }
    } else if (role === 'toolResult' && includeTools) {
      const callId = typeof message.toolCallId === 'string' ? message.toolCallId : ''
      messages.push({
        id, role: 'tool', at, text: cut(text, Math.min(maxChars, 300)),
        ...(toolNames.get(callId) ? { toolName: toolNames.get(callId)! } : {}),
      })
    }
    if (typeof message.model === 'string') models.add(message.model)
  }
  summary.models = [...models].slice(0, 8)
  return { summary, messages: messages.slice(-limit) }
}

/** 读取某张工单最新的会话；没有会话文件时返回 undefined。 */
export function readLatestPiSession(piConfigDir: string, opts: Parameters<typeof readPiSession>[1] = {}): (PiSessionView & { sessions: number }) | undefined {
  const files = listPiSessionFiles(piConfigDir)
  const latest = files[0]
  if (!latest) return undefined
  return { ...readPiSession(latest.file, opts), sessions: files.length }
}

/**
 * 把来源工单最新的会话文件复制进新工单的配置目录，供新工单用 `pi --fork <sessionId>` 继承全部上下文。
 * 复制后原会话文件保持不动；返回被复制会话的 id，来源没有可用会话时返回 undefined。
 */
export function copyLatestSessionForFork(sourceConfigDir: string, targetConfigDir: string): { sessionId: string; file: string } | undefined {
  const latest = listPiSessionFiles(sourceConfigDir)[0]
  if (!latest) return undefined
  const group = basename(join(latest.file, '..'))
  const targetDir = join(targetConfigDir, 'sessions', group)
  mkdirSync(targetDir, { recursive: true })
  const target = join(targetDir, basename(latest.file))
  if (!existsSync(target)) copyFileSync(latest.file, target)
  return { sessionId: latest.sessionId, file: target }
}
