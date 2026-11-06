/**
 * Feishu conversation continuation: the pure rules that let a private-chat message join the ticket the operator was
 * already talking to.
 *
 * A Feishu p2p message normally gets a fresh thread (`<chatId>:<messageId>`), so every message would start a new ticket.
 * These helpers decide whether a message asks for a new task, asks to continue one, or should continue one automatically,
 * and which stored ticket is the newest candidate within the continuation window.
 */

/** How long after its last activity a private-chat ticket may still be continued. */
export const FEISHU_CONTINUE_WINDOW_MS = 24 * 60 * 60 * 1000

export interface ContinuationIntent {
  kind: 'new' | 'continue' | 'auto'
  /** The message with its command prefix removed; the original text when stripping would leave nothing. */
  text: string
}

/** Leading separators and whitespace between a command prefix and the message. */
const SEPARATORS = /^[\s:：]+/

/**
 * Classify a message by its leading command:
 * - `新任务`, `新任务：`, `新任务:`, `/new` → `new`;
 * - `继续` followed by `：`, `:` or whitespace, or `/continue` → `continue`;
 * - anything else → `auto` (continue the conversation when there is a candidate).
 * The command and the separators after it are stripped; an empty remainder keeps the original text.
 */
export function continuationIntent(text: string): ContinuationIntent {
  for (const prefix of ['新任务：', '新任务:', '新任务', '/new']) {
    if (!text.startsWith(prefix)) continue
    const rest = text.slice(prefix.length).replace(SEPARATORS, '')
    return { kind: 'new', text: rest === '' ? text : rest }
  }
  if (text.startsWith('/continue')) {
    const rest = text.slice('/continue'.length).replace(SEPARATORS, '')
    return { kind: 'continue', text: rest === '' ? text : rest }
  }
  if (/^继续[\s:：]/.test(text)) {
    const rest = text.slice('继续'.length).replace(SEPARATORS, '')
    return { kind: 'continue', text: rest === '' ? text : rest }
  }
  return { kind: 'auto', text }
}

export interface ContinuationCandidate {
  ticketId: string
  /** The Feishu thread (`<chatId>:<rootId>`) the ticket is subscribed to. */
  threadId: string
  /** The ticket's last activity, or its thread's, whichever is newer. */
  lastActivityAt: string
  /** A ticket a person stopped never resumes. */
  endedByHuman: boolean
}

export interface PickContinuationInput {
  chatId: string
  chatType: 'p2p' | 'group'
  rootId?: string
  now: Date
  windowMs: number
  candidates: readonly ContinuationCandidate[]
}

/**
 * Pick the ticket a private-chat message continues: the newest candidate on a thread of the same chat, active within the
 * window, that a person did not stop. Group messages never continue automatically: their thread replies already share the
 * root thread, and a new top-level group message is a new task.
 */
export function pickContinuation(input: PickContinuationInput): { ticketId: string; threadId: string } | undefined {
  if (input.chatType !== 'p2p') return undefined
  const prefix = `${input.chatId}:`
  const now = input.now.getTime()
  let best: ContinuationCandidate | undefined
  let bestAt = -Infinity
  for (const candidate of input.candidates) {
    if (candidate.endedByHuman || !candidate.threadId.startsWith(prefix)) continue
    const at = Date.parse(candidate.lastActivityAt)
    if (!Number.isFinite(at) || now - at > input.windowMs) continue
    if (at > bestAt) {
      best = candidate
      bestAt = at
    }
  }
  return best ? { ticketId: best.ticketId, threadId: best.threadId } : undefined
}
