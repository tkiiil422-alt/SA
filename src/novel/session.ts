/**
 * Multi-chapter conversation session pool for novel roles (`writer`, `reviewer`, `planner`, `extractor`).
 *
 * Keeps one append-only `messages` conversation per `(bookId, role, promptHash)` across consecutive chapters so
 * upstream prompt & session caches (especially Gemini 4 and Anthropic) hit on the full prior context while the model
 * writes directly on top of the verbatim previous chapters.
 *
 * Strictly enforces the three cache-reuse invariants:
 *   1. Immutable `system` and immutable prior `history` messages (byte-for-byte identical across turns; dynamic chapter
 *      state is sent only in the trailing `user` message).
 *   2. Never ends with an `assistant` prefill: `prepare()` always returns an even-length `history` ending in `assistant`
 *      (or empty), so `callModel` always finishes with `{ role: 'user' }`.
 *   3. Never mixes models inside one session: if the resolved `(provider, model)` changes, a fresh session with a new
 *      `sessionId` is opened immediately.
 *
 * Rolls over to a fresh session after `maxTurns` (default 8 chapters, within the 5–10 chapter window) or `maxChars`
 * (default 180,000 chars ≈ 90k–120k tokens, within the 80k–150k token budget), or when a book rewrites earlier chapters.
 */
import { createHash } from 'node:crypto'
import type { ChatTurn } from '../assessor/model-call.ts'
import type { Role } from './pipeline.ts'

export interface RoleSessionOptions {
  /** Maximum consecutive turns (chapters) per session before rolling over. Default 8 (5–10 recommended). */
  maxTurns?: number
  /** Approximate character ceiling for accumulated system + history before rolling over. Default 180,000 (~90k–120k tokens). */
  maxChars?: number
}

interface SessionState {
  id: string
  seq: number
  modelKey: string
  /** Frozen byte-for-byte system prompt (base system + initial stable context); never mutated inside the session. */
  frozenSystem: string
  /** Append-only alternating user/assistant turns; never rewritten or truncated mid-session. */
  history: ChatTurn[]
  turns: number
  chars: number
}

export interface PreparedSessionCall {
  sessionId: string
  system: string
  history: readonly ChatTurn[]
  /** Commit the completed `(user, assistant)` pair to the append-only history after a successful non-truncated call. */
  commit(user: string, assistant: string): void
}

function hashPrefix(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 12)
}

export class RoleSessionPool {
  private readonly maxTurns: number
  private readonly maxChars: number
  private readonly sessions = new Map<string, SessionState>()
  private readonly seqs = new Map<string, number>()

  constructor(options: RoleSessionOptions = {}) {
    this.maxTurns = Math.max(1, options.maxTurns ?? 8)
    this.maxChars = Math.max(10_000, options.maxChars ?? 180_000)
  }

  /**
   * Prepare a cache-safe multi-turn call for `(bookId, role)`.
   *
   * `baseSystem` identifies the sub-role (e.g. `WRITER_SYSTEM` vs `REVISER_SYSTEM`, or `PLANNER_SYSTEM` vs
   * `ARC_PLANNER_SYSTEM`) so distinct system prompts never evict each other's session. On turn 1 of a fresh session,
   * `stableContext` (world bible + cast + style rules) is frozen into `system`; subsequent turns reuse the EXACT same
   * frozen `system` and append-only `history` verbatim.
   */
  prepare(input: {
    bookId: string
    role: Role
    modelKey: string
    baseSystem: string
    stableContext?: string
    nextUserChars: number
  }): PreparedSessionCall {
    const slotKey = `${input.bookId}:${input.role}:${hashPrefix(input.baseSystem)}`
    let state = this.sessions.get(slotKey)
    const shouldRollover = !state
      || state.modelKey !== input.modelKey
      || state.turns >= this.maxTurns
      || (state.turns > 0 && state.chars + input.nextUserChars > this.maxChars)

    if (shouldRollover) {
      const seq = (this.seqs.get(slotKey) ?? 0) + 1
      this.seqs.set(slotKey, seq)
      const frozenSystem = input.stableContext && input.stableContext.trim() !== ''
        ? `${input.baseSystem}\n\n${input.stableContext}`
        : input.baseSystem
      state = {
        id: `novel-${input.bookId}-${input.role}-s${seq}`,
        seq,
        modelKey: input.modelKey,
        frozenSystem,
        history: [],
        turns: 0,
        chars: frozenSystem.length,
      }
      this.sessions.set(slotKey, state)
    }

    const active = state!
    // Snapshot the current append-only prefix so callers cannot mutate it mid-flight.
    const snapshot: readonly ChatTurn[] = active.history.slice()
    return {
      sessionId: active.id,
      system: active.frozenSystem,
      history: snapshot,
      commit: (user: string, assistant: string) => {
        // Only commit if this session is still the active one for the slot (not rotated/reset while in flight).
        if (this.sessions.get(slotKey) !== active) return
        if (!user.trim() || !assistant.trim()) return
        active.history.push({ role: 'user', content: user }, { role: 'assistant', content: assistant })
        active.turns += 1
        active.chars += user.length + assistant.length
      },
    }
  }

  /** Drop all cached conversations for a book (for example after `rewriteFrom` rolls back chapters). */
  resetBook(bookId: string): void {
    const prefix = `${bookId}:`
    for (const key of this.sessions.keys()) {
      if (key.startsWith(prefix)) this.sessions.delete(key)
    }
  }

  /** Drop all cached conversations (on shutdown). */
  clear(): void {
    this.sessions.clear()
  }
}
