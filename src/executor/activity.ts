/**
 * What a worker is doing right now, for the task detail page.
 *
 * Pi streams every step on stdout (tool calls, their output, what it says, what it thinks). Only the turn boundaries
 * reached the ticket's events before, so a long run looked frozen. This keeps the most recent steps per ticket in memory:
 * enough to follow progress, never the full transcript, and nothing survives a restart.
 */
import type { DatabaseSync } from 'node:sqlite'
import type { PiEvent } from './pi-rpc.ts'

export type ActivityKind = 'tool' | 'say' | 'think' | 'turn' | 'goal'
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
  /** Model that produced this step, as Pi reported it on the assistant message (the ticket's main worker). */
  model?: string
  /** For a delegation (`subagent`): the sub-agents it runs, each with its model and where it is. */
  agents?: ActivityAgent[]
}

/** Where one sub-agent of a delegation is; `stopped` means the turn or the daemon ended while it worked. */
export type AgentState = 'queued' | 'running' | 'done' | 'failed' | 'stopped'
export interface ActivityAgent {
  role: string
  name?: string
  /** Pi model string, e.g. `sa-gw/claude-opus-5-5`. */
  model?: string
  state: AgentState
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
const KEEP_ROWS = 2_000
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

const ROLE_WORD: Record<string, string> = { scout: '侦察', planner: '规划', reviewer: '审查', advisor: '顾问', helper: '帮手' }
const roleWord = (id: unknown): string => typeof id === 'string' ? (ROLE_WORD[id] ?? id) : '?'

/** One line for a `subagent` call: who was asked and what, e.g. `审查：看 src/gateway 的改动` or `并行 3 个：侦察、侦察、规划；…`. */
export function delegationSummary(args: unknown): string {
  if (!isObject(args)) return argsSummary(args)
  const list = (value: unknown): Record<string, unknown>[] => Array.isArray(value) ? value.filter(isObject) : []
  const chain = list(args.chain)
  if (chain.length > 0) return oneLine(`串联：${chain.map(step => roleWord(step.agent)).join(' → ')}；${String(chain[0]?.task ?? '')}`)
  const tasks = list(args.tasks)
  if (tasks.length > 0) return oneLine(`并行 ${tasks.length} 个：${tasks.map(task => roleWord(task.agent)).join('、')}；${String(tasks[0]?.task ?? '')}`)
  return oneLine(`${roleWord(args.agent)}：${typeof args.task === 'string' ? args.task : ''}`)
}

const AGENT_STATES: readonly AgentState[] = ['queued', 'running', 'done', 'failed', 'stopped']

/** The sub-agents a `subagent` call names, before any of them has started. */
export function agentsFromArgs(args: unknown): ActivityAgent[] | undefined {
  if (!isObject(args)) return undefined
  const list = (value: unknown): Record<string, unknown>[] => Array.isArray(value) ? value.filter(isObject) : []
  const specs = list(args.chain).length > 0 ? list(args.chain) : list(args.tasks).length > 0 ? list(args.tasks) : [args]
  const agents = specs.filter(spec => typeof spec.agent === 'string' && spec.agent !== '').slice(0, 8)
    .map(spec => ({ role: String(spec.agent).slice(0, 40), name: roleWord(spec.agent), state: 'queued' as const }))
  return agents.length > 0 ? agents : undefined
}

/** Sub-agents as the collaboration extension reports them: `details.agents` while it works, `details.results` at the end. */
export function parseAgents(details: unknown): ActivityAgent[] | undefined {
  if (!isObject(details)) return undefined
  const list = Array.isArray(details.agents) ? details.agents : Array.isArray(details.results) ? details.results : undefined
  if (list === undefined) return undefined
  const agents: ActivityAgent[] = []
  for (const item of list.slice(0, 8)) {
    if (!isObject(item) || typeof item.role !== 'string' || item.role === '') continue
    const state: AgentState = AGENT_STATES.includes(item.state as AgentState) ? item.state as AgentState
      : typeof item.ok === 'boolean' ? (item.ok ? 'done' : 'failed') : 'running'
    agents.push({
      role: item.role.slice(0, 40),
      ...(typeof item.name === 'string' && item.name ? { name: item.name.slice(0, 40) } : {}),
      ...(typeof item.model === 'string' && item.model ? { model: item.model.slice(0, 120) } : {}),
      state,
      ...(typeof item.ms === 'number' && Number.isFinite(item.ms) ? { ms: Math.max(0, Math.round(item.ms)) } : {}),
    })
  }
  return agents.length > 0 ? agents : undefined
}

/** The turn or the daemon ended under a delegation: a sub-agent still working never finished. */
const stopAgents = (agents: ActivityAgent[] | undefined): ActivityAgent[] | undefined =>
  agents?.map(agent => agent.state === 'running' ? { ...agent, state: 'stopped' as const } : agent)

/** A delegation that ended without reporting its sub-agents: the ones working finished as the call did. */
const settleAgents = (agents: ActivityAgent[] | undefined, failed: boolean): ActivityAgent[] | undefined =>
  agents?.map(agent => agent.state === 'running' ? { ...agent, state: failed ? 'stopped' as const : 'done' as const } : agent)

/** Sub-agents saved with a step; ones still working when the daemon stopped never finished. */
function storedAgents(json: string, interrupted: boolean): { agents?: ActivityAgent[] } {
  try {
    const agents = parseAgents({ agents: JSON.parse(json) })
    if (agents === undefined) return {}
    return { agents: interrupted ? stopAgents(agents) ?? agents : agents }
  } catch {
    return {}
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
  ticketId: string
  entries: ActivityEntry[]
  open: Map<string, { entry: ActivityEntry; startedAt: number }>
  /** Model of the latest assistant message, so the tool steps it started carry it too. */
  model?: string
}

export class ActivityLog {
  private readonly logs = new Map<string, TicketLog>()
  private seq = 0
  private readonly db: DatabaseSync | undefined

  /** With a database the steps survive a restart; without one the log is memory only (tests, tools). */
  constructor(private readonly now: () => Date = () => new Date(), db?: DatabaseSync) {
    this.db = db
    if (db) {
      db.exec(`CREATE TABLE IF NOT EXISTS activity_steps (
        id INTEGER PRIMARY KEY, ticket_id TEXT NOT NULL, seq INTEGER NOT NULL, at TEXT NOT NULL, kind TEXT NOT NULL,
        tool TEXT, summary TEXT NOT NULL, detail TEXT, status TEXT NOT NULL, ms INTEGER)`)
      db.exec('CREATE INDEX IF NOT EXISTS activity_steps_ticket ON activity_steps (ticket_id, seq)')
      // Columns added later: who made a step (model) and, for a delegation, its sub-agents (JSON).
      const columns = db.prepare('PRAGMA table_info(activity_steps)').all()
      if (!columns.some(column => column.name === 'model')) db.exec('ALTER TABLE activity_steps ADD COLUMN model TEXT')
      if (!columns.some(column => column.name === 'agents')) db.exec('ALTER TABLE activity_steps ADD COLUMN agents TEXT')
      const row = db.prepare('SELECT MAX(id) AS a, MAX(seq) AS b FROM activity_steps').get() as { a: number | null; b: number | null }
      this.seq = Math.max(row.a ?? 0, row.b ?? 0)
    }
  }

  private save(ticketId: string, e: ActivityEntry): void {
    if (!this.db) return
    try {
      this.db.prepare('INSERT OR REPLACE INTO activity_steps (id, ticket_id, seq, at, kind, tool, summary, detail, status, ms, model, agents) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(e.id, ticketId, e.seq, e.at, e.kind, e.tool ?? null, e.summary, e.detail ?? null, e.status, e.ms ?? null,
          e.model ?? null, e.agents ? JSON.stringify(e.agents) : null)
      // Keep the newest ACTIVITY_KEEP rows per ticket.
      this.db.prepare('DELETE FROM activity_steps WHERE ticket_id = ? AND seq <= (SELECT seq FROM activity_steps WHERE ticket_id = ? ORDER BY seq DESC LIMIT 1 OFFSET ?)')
        .run(ticketId, ticketId, KEEP_ROWS)
    } catch { /* history is best effort; the live log still works */ }
  }

  private load(ticketId: string): ActivityEntry[] {
    if (!this.db) return []
    try {
      const rows = this.db.prepare('SELECT * FROM activity_steps WHERE ticket_id = ? ORDER BY seq DESC LIMIT ?').all(ticketId, MAX_ENTRIES) as Array<Record<string, unknown>>
      return rows.reverse().map(r => ({
        id: Number(r.id), seq: Number(r.seq), at: String(r.at), kind: r.kind as ActivityKind,
        ...(r.tool ? { tool: String(r.tool) } : {}), summary: String(r.summary),
        ...(r.detail ? { detail: String(r.detail) } : {}),
        // A step that was still running when the daemon stopped will never finish.
        status: r.status === 'running' ? 'error' : (r.status as ActivityStatus),
        ...(r.ms != null ? { ms: Number(r.ms) } : {}),
        ...(r.model ? { model: String(r.model) } : {}),
        ...(r.agents ? storedAgents(String(r.agents), r.status === 'running') : {}),
      }))
    } catch { return [] }
  }

  private log(ticketId: string): TicketLog {
    let log = this.logs.get(ticketId)
    if (!log) {
      log = { ticketId, entries: this.load(ticketId), open: new Map() }
      this.logs.set(ticketId, log)
    }
    return log
  }

  private push(log: TicketLog, entry: Omit<ActivityEntry, 'id' | 'seq' | 'at'>): ActivityEntry {
    this.seq += 1
    const full: ActivityEntry = { id: this.seq, seq: this.seq, at: this.now().toISOString(), ...entry }
    log.entries.push(full)
    this.save(log.ticketId, full)
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
        const summary = tool === 'subagent' ? delegationSummary(event.args) : argsSummary(event.args)
        const agents = tool === 'subagent' ? agentsFromArgs(event.args) : undefined
        const entry = this.push(log, { kind: 'tool', tool, summary, status: 'running', ...(log.model ? { model: log.model } : {}), ...(agents ? { agents } : {}) })
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
          if (open.entry.tool === 'subagent') {
            const final = isObject(event.result) ? parseAgents(event.result.details) : undefined
            open.entry.agents = final ?? settleAgents(open.entry.agents, failed)
          }
          // Move the seq forward so a poller that already saw the start also receives the finished step.
          this.seq += 1
          open.entry.seq = this.seq
          log.entries.splice(log.entries.indexOf(open.entry), 1)
          log.entries.push(open.entry)
          this.save(log.ticketId, open.entry)
        } else {
          const tool = typeof event.toolName === 'string' ? event.toolName : 'tool'
          this.push(log, { kind: 'tool', tool, summary: '', ...(output ? { detail: output } : {}), status: failed ? 'error' : 'done' })
        }
        return
      }
      case 'tool_execution_update': {
        // Only a delegation reports progress worth keeping: which sub-agent is on which step, refreshed every ~20 s.
        if (event.toolName !== 'subagent') return
        const id = typeof event.toolCallId === 'string' ? event.toolCallId : ''
        const open = id ? log.open.get(id) : undefined
        const note = isObject(event.partialResult) ? tail(resultText(event.partialResult).trim()) : ''
        const agents = isObject(event.partialResult) ? parseAgents(event.partialResult.details) : undefined
        if (!open) return
        const newNote = note !== '' && open.entry.detail !== note
        const newAgents = agents !== undefined && JSON.stringify(agents) !== JSON.stringify(open.entry.agents)
        if (!newNote && !newAgents) return
        if (newNote) open.entry.detail = note
        if (agents !== undefined) open.entry.agents = agents
        this.seq += 1
        open.entry.seq = this.seq
        log.entries.splice(log.entries.indexOf(open.entry), 1)
        log.entries.push(open.entry)
        this.save(log.ticketId, open.entry)
        return
      }
      case 'message_end': {
        const message = isObject(event.message) ? event.message : undefined
        if (!message || message.role !== 'assistant') return
        if (typeof message.model === 'string' && message.model.trim()) log.model = message.model.trim().slice(0, 120)
        const by = log.model ? { model: log.model } : {}
        const content = Array.isArray(message.content) ? message.content : []
        for (const part of content) {
          if (!isObject(part)) continue
          if (part.type === 'thinking' && typeof part.thinking === 'string' && part.thinking.trim()) {
            this.push(log, { kind: 'think', summary: oneLine(part.thinking), detail: head(part.thinking), status: 'done', ...by })
          } else if (part.type === 'text' && typeof part.text === 'string' && part.text.trim()) {
            this.push(log, { kind: 'say', summary: oneLine(part.text), detail: head(part.text), status: 'done', ...by })
          }
        }
        return
      }
      case 'agent_settled': {
        // Anything still open will never get its end record; do not leave it spinning.
        for (const { entry } of log.open.values()) { entry.status = 'error'; entry.agents = stopAgents(entry.agents); this.save(log.ticketId, entry) }
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

  /** A ticket goal's check or push, as a step of its own. */
  goal(ticketId: string, summary: string, detail: string, status: 'done' | 'error'): void {
    this.push(this.log(ticketId), { kind: 'goal', summary: oneLine(summary), ...(detail.trim() ? { detail: head(detail) } : {}), status })
  }

  list(ticketId: string, after = 0, limit = 120): ActivityView {
    const log = this.logs.get(ticketId) ?? (this.db ? this.log(ticketId) : undefined)
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
    try { this.db?.prepare('DELETE FROM activity_steps WHERE ticket_id = ?').run(ticketId) } catch { /* best effort */ }
  }
}
