/**
 * The CLI Source: every `sa ask` request is one Trigger on a fresh Thread, written by the configured operator.
 *
 * A CLI message is addressed to the agent directly, like a Feishu direct message, so the Policy grants it explicit
 * strength. The Source is also the runtime's `SourceScope`: the CLI listens to its own messages only.
 */
import { randomUUID } from 'node:crypto'
import { key } from '../core/ids.ts'
import type { ScopeResult, SourceScope, Trigger } from '../core/index.ts'

export interface CliSourceOptions {
  /** Actor id recorded on every Trigger; the Policy's `cli` allow-list must name it. */
  operatorId: string
  now?: () => string
  /** Thread id generator, injectable for tests. */
  newThreadId?: () => string
}

export class CliSource implements SourceScope {
  readonly source = 'cli'
  private readonly now: () => string
  private readonly newThreadId: () => string

  constructor(private readonly options: CliSourceOptions) {
    this.now = options.now ?? (() => new Date().toISOString())
    this.newThreadId = options.newThreadId ?? (() => randomUUID())
  }

  /** Turn one CLI request into a Trigger on a new Thread. */
  ask(text: string): Trigger {
    const threadId = this.newThreadId()
    return this.trigger(threadId, key('trigger', this.source, threadId), text)
  }

  /**
   * A person's follow-up on an existing Thread, so an answer lands where the ticket's conversation already is. The Trigger
   * id salts the thread with a fresh value: unlike `ask`, the same Thread takes many messages, and each needs its own id.
   */
  followup(threadId: string, text: string): Trigger {
    return this.trigger(threadId, key('trigger', this.source, threadId, randomUUID()), text)
  }

  private trigger(threadId: string, id: string, text: string): Trigger {
    const ref = { source: this.source, id: threadId }
    return {
      id,
      source: this.source,
      threads: [ref],
      actor: { source: this.source, id: this.options.operatorId },
      human: true,
      addressed: 'direct',
      at: this.now(),
      text,
      channel: { source: this.source, thread: threadId, address: { thread: threadId } },
      meta: { direct: true },
    }
  }

  scope(input: { source: string; meta: Record<string, unknown> }): ScopeResult {
    return input.source === this.source
      ? { listened: true, observed: true, row: 'cli' }
      : { listened: false, reason: 'source_disabled' }
  }
}
