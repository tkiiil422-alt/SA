/**
 * Test doubles and record factories for `src/policy.ts`.
 *
 * The prototype's policy spec built its SourceScope from the Source registry. Here a minimal SourceScope reads the
 * receiving scope a test put on a Trigger's `meta`, which is also the `basis.scope` that a recorded Mandate carries.
 */
import { SettingsSchema, type Rule, type Settings, type SourcePolicy } from '../../src/policy.ts'
import type { AcceptMode, ActorRef, Mandate, MandateBasis, ScopeResult, SourceScope, Thread, Ticket, Trigger }
  from '../../src/core/index.ts'

export const SOURCE = 'feishu'
export const CHAT = 'oc_team'

export const MEMBER: ActorRef = { source: SOURCE, id: 'ou_alice' }
export const GUEST: ActorRef = { source: SOURCE, id: 'ou_guest' }
export const BOT: ActorRef = { source: SOURCE, id: 'cli_alerts' }
export const ALICE = { id: 'ou_alice', name: 'Alice' }
export const BOT_ENTRY = { id: 'cli_alerts', name: 'Alerts' }

export const RULES: Rule[] = [
  { id: 'copy', name: 'Copy fixes', enabled: true, instruction: 'Fix copy.' },
  { id: 'visual', name: 'Visual fixes', enabled: true, instruction: 'Fix visuals.' },
]

/** Parse settings with two enabled rules, Alice allowed on Feishu, and auto accept mode unless overridden. */
export function settings(input: Record<string, unknown> = {}): Settings {
  return SettingsSchema.parse({
    policy: { rules: RULES, sources: { [SOURCE]: { allowed: [ALICE], admission: {} } } },
    eval: { mode: 'auto' },
    ...input,
  })
}

export const withMode = (value: Settings, mode: AcceptMode): Settings =>
  ({ ...value, eval: { ...value.eval, mode } })
export const withRules = (value: Settings, rules: Rule[]): Settings =>
  ({ ...value, policy: { ...value.policy, rules } })
export const withSource = (value: Settings, source: string, part: SourcePolicy): Settings =>
  ({ ...value, policy: { ...value.policy, sources: { ...value.policy.sources, [source]: part } } })
export const withPart = (value: Settings, part: SourcePolicy): Settings => withSource(value, SOURCE, part)
export function withoutSource(value: Settings, source: string = SOURCE): Settings {
  const { [source]: _removed, ...sources } = value.policy.sources
  return { ...value, policy: { ...value.policy, sources } }
}

export const openScope = (row: string = CHAT, observed = false): ScopeResult => ({ listened: true, observed, row })
export const silentScope = (reason = 'source_disabled'): ScopeResult => ({ listened: false, reason })
/** Attach a receiving scope to a Trigger's `meta`, where the gate and a recorded Mandate basis read it. */
export const recordScope = (scope: ScopeResult, extra: Record<string, unknown> = {}): Record<string, unknown> =>
  ({ ...extra, __scope: scope })

/** A minimal SourceScope: whatever scope a Trigger's or Mandate's `meta` carries, listening by default. */
export const sourceScope: SourceScope = {
  scope: ({ meta }) => (meta.__scope as ScopeResult | undefined) ?? openScope(),
}

export function trigger(overrides: Partial<Trigger> = {}): Trigger {
  return {
    id: 't1', source: SOURCE, threads: [{ source: SOURCE, id: 'thread-1' }], actor: MEMBER, human: true,
    addressed: 'mention', at: '', text: 'hi', meta: recordScope(openScope()), ...overrides,
  }
}
export function humanMessage(scope: ScopeResult = openScope(), overrides: Partial<Trigger> = {}): Trigger {
  return trigger({ ...overrides, meta: recordScope(scope) })
}
export function botMessage(scope: ScopeResult = openScope(), overrides: Partial<Trigger> = {}): Trigger {
  return trigger({ human: false, actor: BOT, addressed: 'mention', ...overrides, meta: recordScope(scope) })
}

export function thread(subscriptions: string[] = [], context?: string[]): Thread {
  const value: Thread = {
    key: 'feishu:thread-1', ref: { source: SOURCE, id: 'thread-1' }, createdAt: '',
    subscriptions, correlated: [], pending: [], meta: {},
  }
  return context ? { ...value, context } : value
}

export function mandate(strength: Mandate['strength'], basis: MandateBasis, actor: ActorRef = MEMBER): Mandate {
  return { strength, policyVersion: 'v1', basis, actor, scope: '' }
}
export const ticket = (id: string, value: Mandate): Ticket => ({ id, mandate: value } as unknown as Ticket)
