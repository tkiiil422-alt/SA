/**
 * What a worker is doing right now, for the task detail page.
 *
 * Pi streams every step on stdout (tool calls, their output, what it says, what it thinks). Only the turn boundaries
 * reached the ticket's events before, so a long run looked frozen. This keeps the most recent steps per ticket in memory:
 * enough to follow progress, never the full transcript, and nothing survives a restart.
 */
import type { PiEvent } from './pi-rpc.ts'

export type ActivityKind = 'tool' | 'say' | 'think' | 'turn'
export type ActivityStatus = 'running' | 'done' | 'error'

export interface ActivityEntry {
  /** Stable for the life of the entry; `seq` moves forward when a running tool finishes. */
  id: number
  seq: number
  at: string
  kind: ActivityKind
  /** Tool name for `tool` entries. */
  tool?: string
  /** One line: the command, the path, or the start of what it said. */
  summary: string
  /** Tail of the tool's output, or the full short text of a `say`/`think` entry. */
  detail?: string
  status: ActivityStatus
  ms?: number
}

export interface ActivityView {
  items: ActivityEntry[]
  /** Highest seq in the log, so a poller can ask only for newer entries. */
  last: number
  /** When the newest entry was written, or undefined when nothing was recorded since the daemon started. */
  updatedAt?: string
}

const MAX_ENTRIES = 300
const SUMMARY_CHARS = 240
const DETAIL_CHARS = 1_600

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

function oneLine(text: string, limit = SUMMARY_CHARS): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= limit ? flat : `${flat.slice(0, limit)}…`
}

function tail(text: string, limit = DETAIL_CHARS): string {
  const trimmed = text.replace(/\s+$/, '')
  return trimmed.length <= limit ? trimmed : `…${trimmed.slice(-limit)}`
}

function head(text: string, limit = DETAIL_CHARS): string {
  const trimmed = text.trim()
  return trimmed.length <= limit ? trimmed : `${trimmed.slice(0, limit)}…`
}

/** The most telling argument of a tool call: a command, a path, a URL, else the JSON. */
export function argsSummary(args: unknown): string {
  if (!isObject(args)) return typeof args === 'string' ? oneLine(args) : ''
  for (const key of ['command', 'path', 'file_path', 'url', 'query', 'pattern']) {
    const value = args[key]
    if (typeof value === 'string' && value.trim() !== '') return oneLine(value)
  }
  try {
    return oneLine(JSON.stringify(args))
  } catch {
    return ''
  }
}

/** Text parts of a tool result; images become a marker, never their bytes. */
export function resultText(result: unknown): string {
  if (typeof result === 'string') return result
  if (!isObject(result)) return ''
  const content = Array.isArray(result.content) ? result.content : []
  const parts: string[] = []
  for (const part of content) {
    if (!isObject(part)) continue
    if (part.type === 'text' && typeof part.text === 'string') parts.push(part.text)
    else if (part.type === 'image') parts.push('[图片]')
  }
  return parts.join('\n')
}

interface TicketLog {
  entries: ActivityEntry[]
  open: Map<string, { entry: ActivityEntry; startedAt: number }>
}

export class ActivityLog {
  private readonly logs = new Map<string, TicketLog>()
  private seq = 0

  constructor(private readonly now: () => Date = () => new Date()) {}

  private log(ticketId: string): TicketLog {
    let log = this.logs.get(ticketId)
    if (!log) {
      log = { entries: [], open: new Map() }
      this.logs.set(ticketId, log)
    }
    return log
  }

  private push(log: TicketLog, entry: Omit<ActivityEntry, 'id' | 'seq' | 'at'>): ActivityEntry {
    this.seq += 1
    const full: ActivityEntry = { id: this.seq, seq: this.seq, at: this.now().toISOString(), ...entry }
    log.entries.push(full)
    if (log.entries.length > MAX_ENTRIES) log.entries.splice(0, log.entries.length - MAX_ENTRIES)
    return full
  }

  /** Feed one Pi stdout record. Streaming deltas are ignored; only finished steps are kept. */
  record(ticketId: string, event: PiEvent): void {
    const log = this.log(ticketId)
    switch (event.type) {
      case 'tool_execution_start': {
        const id = typeof event.toolCallId === 'string' ? event.toolCallId : ''
        const tool = typeof event.toolName === 'string' ? event.toolName : 'tool'
        const entry = this.push(log, { kind: 'tool', tool, summary: argsSummary(event.args), status: 'running' })
        if (id) log.open.set(id, { entry, startedAt: this.now().getTime() })
        return
      }
      case 'tool_execution_end': {
        const id = typeof event.toolCallId === 'string' ? event.toolCallId : ''
        const open = id ? log.open.get(id) : undefined
        const output = tail(resultText(event.result))
        const failed = event.isError === true
        if (open) {
          log.open.delete(id)
          open.entry.status = failed ? 'error' : 'done'
          open.entry.ms = Math.max(0, this.now().getTime() - open.startedAt)
          if (output) open.entry.detail = output
          // Move the seq forward so a poller that already saw the start also receives the finished step.
          this.seq += 1
          open.entry.seq = this.seq
          log.entries.splice(log.entries.indexOf(open.entry), 1)
          log.entries.push(open.entry)
        } else {
          const tool = typeof event.toolName === 'string' ? event.toolName : 'tool'
          this.push(log, { kind: 'tool', tool, summary: '', ...(output ? { detail: output } : {}), status: failed ? 'error' : 'done' })
        }
        return
      }
      case 'message_end': {
        const message = isObject(event.message) ? event.message : undefined
        if (!message || message.role !== 'assistant') return
        const content = Array.isArray(message.content) ? message.content : []
        for (const part of content) {
          if (!isObject(part)) continue
          if (part.type === 'thinking' && typeof part.thinking === 'string' && part.thinking.trim()) {
            this.push(log, { kind: 'think', summary: oneLine(part.thinking), detail: head(part.thinking), status: 'done' })
          } else if (part.type === 'text' && typeof part.text === 'string' && part.text.trim()) {
            this.push(log, { kind: 'say', summary: oneLine(part.text), detail: head(part.text), status: 'done' })
          }
        }
        return
      }
      case 'agent_settled': {
        // Anything still open will never get its end record; do not leave it spinning.
        for (const { entry } of log.open.values()) entry.status = 'error'
        log.open.clear()
        this.push(log, { kind: 'turn', summary: '这一轮结束', status: 'done' })
        return
      }
      default:
        return
    }
  }

  /** Note something the host did to the worker (start, wake, stop), so the log explains gaps. */
  note(ticketId: string, summary: string): void {
    this.push(this.log(ticketId), { kind: 'turn', summary, status: 'done' })
  }

  list(ticketId: string, after = 0, limit = 120): ActivityView {
    const log = this.logs.get(ticketId)
    if (!log) return { items: [], last: 0 }
    const newer = log.entries.filter(entry => entry.seq > after)
    const items = newer.slice(-Math.max(1, Math.min(MAX_ENTRIES, limit)))
    const lastEntry = log.entries[log.entries.length - 1]
    return {
      items: items.map(entry => ({ ...entry })),
      last: log.entries.reduce((max, entry) => Math.max(max, entry.seq), 0),
      ...(lastEntry ? { updatedAt: lastEntry.at } : {}),
    }
  }

  forget(ticketId: string): void {
    this.logs.delete(ticketId)
  }
}
