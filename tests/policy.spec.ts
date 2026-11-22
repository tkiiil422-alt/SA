import { describe, expect, it } from 'vitest'
import { assessmentOutcome, policyEffects, policyVersion, settingsPolicy, type Assessment, type Settings }
  from '../src/policy.ts'
import type { MandateBasis, SourceScope } from '../src/core/index.ts'
import { ALICE, BOT, BOT_ENTRY, CHAT, GUEST, MEMBER, RULES, SOURCE, botMessage, humanMessage, mandate,
  openScope, recordScope, settings, silentScope, sourceScope, thread, ticket, trigger, withMode, withPart, withRules,
  withSource, withoutSource } from './fixtures/policy.ts'

const policyOf = (value: Settings, scope: SourceScope = sourceScope) => settingsPolicy(value, scope)

describe('gate: strength and admission', () => {
  // docs/002 "Strength": a person on the list who addresses the agent makes an explicit request.
  it('grants explicit strength when a listed member addresses the agent', () => {
    expect(policyOf(settings()).gate(trigger(), thread(), [])).toMatchObject({
      admissible: true, strength: 'explicit',
      basis: { via: 'addressed', source: SOURCE, sender: 'Alice', addressed: 'mention' },
    })
  })
  // docs/002 "Two paths for a Trigger": `direct` is the other way a person addresses the agent.
  it('grants explicit strength when a listed member sends a direct message', () => {
    expect(policyOf(settings()).gate(trigger({ addressed: 'direct' }), thread(), [])).toMatchObject({
      admissible: true, strength: 'explicit', basis: { via: 'addressed', addressed: 'direct', sender: 'Alice' },
    })
  })
  // docs/002 "Strength": a person on the list who follows up on a Thread that already has a Ticket is explicit.
  it('grants explicit follow-up strength to a listed member on a thread with tickets', () => {
    expect(policyOf(settings()).gate(humanMessage(openScope(), { addressed: undefined }), thread(['t1']), []))
      .toMatchObject({ admissible: true, strength: 'explicit', basis: { via: 'followup', sender: 'Alice' } })
  })
  // docs/002 "Strength": a person not on the list who follows up on a Thread with a Ticket is inferred.
  it('grants inferred follow-up strength to an unlisted sender on a thread with tickets', () => {
    expect(policyOf(settings()).gate(humanMessage(openScope(), { actor: GUEST, addressed: undefined }), thread(['t1']), []))
      .toMatchObject({ admissible: true, strength: 'inferred', basis: { via: 'followup' } })
  })
  // docs/002 "Strength": an explicit admission cell takes precedence even on a Thread with Tickets and in every mode.
  it('lets an explicit admission cell override follow-up strength in every accept mode', () => {
    const table = withPart(settings(), { allowed: [ALICE], admission: { [CHAT]: { unlistedAddressed: 'explicit' } } })
    for (const mode of ['auto', 'observe', 'off'] as const) {
      expect(policyOf(withMode(table, mode)).gate(trigger({ actor: GUEST }), thread(['t1']), [])).toMatchObject({
        admissible: true, strength: 'explicit', basis: { via: 'admission', cell: 'unlistedAddressed' },
      })
    }
  })
  // docs/002 "Admission": the "on the list, not addressing the agent" cell defaults to inferred.
  it('defaults a listed sender\'s unaddressed message in an observed scope to an inferred candidate', () => {
    expect(policyOf(settings()).gate(humanMessage(openScope(CHAT, true), { addressed: undefined }), thread(), []))
      .toMatchObject({ admissible: true, strength: 'inferred',
        basis: { via: 'admission', cell: 'listedUnaddressed', observation: { mode: 'auto' } } })
  })
  // docs/002 "Admission": the two unlisted cells default to ignore.
  it('ignores an unlisted sender\'s message by default, addressed or not', () => {
    expect(policyOf(settings()).gate(trigger({ actor: GUEST }), thread(), []))
      .toEqual({ admissible: false, reason: 'not_a_member' })
    expect(policyOf(settings()).gate(humanMessage(openScope(CHAT, true), { actor: GUEST, addressed: undefined }), thread(), []))
      .toEqual({ admissible: false, reason: 'not_a_member' })
  })
  // docs/002 "Admission table": "on the list, not addressing" can be set to ignore.
  it('ignores a listed sender\'s unaddressed message where its admission cell says ignore', () => {
    const strict = withPart(settings(), { allowed: [ALICE], admission: { [CHAT]: { listedUnaddressed: 'ignore' } } })
    expect(policyOf(strict).gate(humanMessage(openScope(CHAT, true), { addressed: undefined }), thread(), []))
      .toEqual({ admissible: false, reason: 'admission_ignored' })
  })
  // docs/002 "Admission": unaddressed cells are available only where the Source receives every message.
  it('does not use admission cells for unaddressed messages in a mentions-only scope', () => {
    const strict = withPart(settings(), { allowed: [ALICE], admission: { [CHAT]: { listedUnaddressed: 'inferred' } } })
    expect(policyOf(strict).gate(humanMessage(openScope(CHAT, false), { addressed: undefined }), thread(), []))
      .toEqual({ admissible: false, reason: 'no_mention' })
  })
  // docs/002 "Admission table": "not on the list, addressing the agent" may be set to inferred.
  it('admits an inferred admission cell only while accept mode is not off', () => {
    const inferred = withPart(settings(), { allowed: [ALICE], admission: { [CHAT]: { unlistedAddressed: 'inferred' } } })
    expect(policyOf(inferred).gate(trigger({ actor: GUEST }), thread(), [])).toMatchObject({
      admissible: true, strength: 'inferred',
      basis: { via: 'admission', cell: 'unlistedAddressed', observation: { mode: 'auto' } },
    })
    expect(policyOf(withMode(inferred, 'off')).gate(trigger({ actor: GUEST }), thread(), []))
      .toEqual({ admissible: false, reason: 'not_a_member' })
  })
  // docs/002 "Subscriptions": a direct-message thread belongs to one sender, so an unlisted sender gets no follow-up.
  it('does not treat an unlisted sender\'s direct message as a follow-up', () => {
    expect(policyOf(settings()).gate(trigger({ actor: GUEST, addressed: 'direct' }), thread(['t1']), []))
      .toEqual({ admissible: false, reason: 'not_a_member' })
  })
  // docs/002 "Admission": follow-ups normally bypass the table, except that an explicit cell still grants explicit.
  it('keeps a listed follow-up explicit even where the unaddressed cell says ignore', () => {
    const strict = withPart(settings(), { allowed: [ALICE], admission: { [CHAT]: { listedUnaddressed: 'ignore' } } })
    expect(policyOf(strict).gate(humanMessage(openScope(CHAT, true), { addressed: undefined }), thread(['t1']), []))
      .toMatchObject({ admissible: true, strength: 'explicit', basis: { via: 'followup' } })
  })
  // docs/002 "Context-only subscriptions": messages there grant no follow-up strength; the admission table decides.
  it('uses the admission table for a thread followed only for context', () => {
    expect(policyOf(settings()).gate(humanMessage(openScope(CHAT, true), { addressed: undefined }), thread(['t1'], ['t1']), []))
      .toMatchObject({ admissible: true, strength: 'inferred', basis: { via: 'admission' } })
  })
  // docs/002 "Strength": every inferred case is not admitted while the accept mode is off.
  it('does not admit an unlisted follow-up while accept mode is off', () => {
    expect(policyOf(withMode(settings(), 'off')).gate(humanMessage(openScope(), { actor: GUEST, addressed: undefined }), thread(['t1']), []))
      .toEqual({ admissible: false, reason: 'not_a_member' })
  })
  // docs/002 "Strength": explicit requests work in every mode, including a listed follow-up under off.
  it('still admits a listed follow-up while accept mode is off', () => {
    expect(policyOf(withMode(settings(), 'off')).gate(humanMessage(openScope(), { addressed: undefined }), thread(['t1']), []))
      .toMatchObject({ admissible: true, strength: 'explicit', basis: { via: 'followup' } })
  })
  // docs/002 "Bots and automated reviewers": a listed bot can produce an inferred candidate, never an explicit request.
  it('admits a listed bot as an inferred candidate, never explicit', () => {
    const withBot = withPart(settings(), { allowed: [ALICE], bots: [BOT_ENTRY], admission: {} })
    expect(policyOf(withBot).gate(botMessage(openScope()), thread(['t1']), [])).toMatchObject({
      admissible: true, strength: 'inferred',
      basis: { via: 'bot', sender: 'Alerts', addressed: 'mention', observation: { mode: 'auto' } },
    })
  })
  // docs/002 "Bots and automated reviewers": any other bot's message is not admitted.
  it('rejects a bot that is not on the source\'s bot list', () => {
    expect(policyOf(settings()).gate(trigger({ human: false, actor: { source: SOURCE, id: 'renovate[bot]' }, addressed: 'mention' }), thread(), []))
      .toEqual({ admissible: false, reason: 'not_human' })
  })
  // docs/002 "Accept mode": off admits no bot candidate either.
  it('does not admit a listed bot while accept mode is off', () => {
    const withBot = withPart(settings(), { allowed: [ALICE], bots: [BOT_ENTRY], admission: {} })
    expect(policyOf(withMode(withBot, 'off')).gate(botMessage(openScope()), thread(), []))
      .toEqual({ admissible: false, reason: 'admission_ignored' })
  })
  // docs/002 "Bots and automated reviewers": a listed bot must address the agent or post where every message is received.
  it('admits a listed bot in an observed scope without a mention, but not in a mentions-only scope', () => {
    const withBot = withPart(settings(), { allowed: [ALICE], bots: [BOT_ENTRY], admission: {} })
    expect(policyOf(withBot).gate(botMessage(openScope(CHAT, true), { addressed: undefined }), thread(), []))
      .toMatchObject({ admissible: true, strength: 'inferred', basis: { via: 'bot', observation: { mode: 'auto' } } })
    expect(policyOf(withBot).gate(botMessage(openScope(CHAT, false), { addressed: undefined }), thread(), []))
      .toEqual({ admissible: false, reason: 'not_human' })
  })
})

describe('admitsInferred', () => {
  // docs/007 "Policy": proactive acceptance is permitted only in auto mode with enabled matching rules.
  it('admits inferred candidates only in auto mode with enabled rules', () => {
    const auto = policyOf(settings())
    expect(auto.admitsInferred(['copy'])).toBe(true)
    expect(auto.admitsInferred(['copy', 'visual'])).toBe(true)
    expect(auto.admitsInferred([])).toBe(false)
    expect(auto.admitsInferred(['unknown'])).toBe(false)
    expect(policyOf(withMode(settings(), 'observe')).admitsInferred(['copy'])).toBe(false)
    expect(policyOf(withMode(settings(), 'off')).admitsInferred(['copy'])).toBe(false)
  })
  // docs/002 "Accept mode and rules": a proactive accept requires the matched rules to be enabled.
  it('rejects a candidate that matched a disabled rule', () => {
    const disabled = withRules(settings(), [{ ...RULES[0]!, enabled: false }, RULES[1]!])
    expect(policyOf(disabled).admitsInferred(['copy'])).toBe(false)
    expect(policyOf(disabled).admitsInferred(['visual'])).toBe(true)
  })
})

describe('revalidate', () => {
  // docs/002 "Revalidation": other Mandates require the sender to remain on the Source's allowed list.
  it('invalidates an addressed Mandate when the member leaves the allowed list', () => {
    const basis: MandateBasis = { via: 'addressed', addressed: 'mention', source: SOURCE, scope: recordScope(openScope()) }
    const value = mandate('explicit', basis)
    expect(policyOf(settings()).revalidate(value)).toBe(true)
    expect(policyOf(withPart(settings(), { allowed: [], admission: {} })).revalidate(value)).toBe(false)
    expect(policyOf(withoutSource(settings())).revalidate(value)).toBe(false)
  })
  // docs/002 "Revalidation": the Source must still listen to the original Thread.
  it('invalidates any Mandate when the source stops listening to the thread', () => {
    const basis: MandateBasis = { via: 'addressed', addressed: 'mention', source: SOURCE, scope: recordScope(silentScope()) }
    expect(policyOf(settings()).revalidate(mandate('explicit', basis))).toBe(false)
  })
  // docs/002 "Revalidation": an explicit follow-up Mandate passes.
  it('passes an explicit follow-up Mandate in every accept mode', () => {
    const basis: MandateBasis = { via: 'followup', source: SOURCE, scope: recordScope(openScope()) }
    for (const mode of ['auto', 'observe', 'off'] as const) {
      expect(policyOf(withMode(settings(), mode)).revalidate(mandate('explicit', basis))).toBe(true)
    }
  })
  // docs/002 "Revalidation": an inferred Mandate needs auto mode and its matched rules still enabled.
  it('invalidates an inferred follow-up Mandate outside auto mode or when a matched rule is disabled', () => {
    const basis: MandateBasis = { via: 'followup', source: SOURCE, scope: recordScope(openScope()), rules: ['copy'] }
    const value = mandate('inferred', basis)
    expect(policyOf(settings()).revalidate(value)).toBe(true)
    expect(policyOf(withMode(settings(), 'observe')).revalidate(value)).toBe(false)
    expect(policyOf(withMode(settings(), 'off')).revalidate(value)).toBe(false)
    const disabled = withRules(settings(), [{ ...RULES[0]!, enabled: false }, RULES[1]!])
    expect(policyOf(disabled).revalidate(value)).toBe(false)
  })
  // docs/002 "Revalidation": a table Mandate must still receive at least its original strength from today's cell.
  it('invalidates an explicit admission Mandate once its cell weakens', () => {
    const table = (cell: 'explicit' | 'inferred' | 'ignore') =>
      withPart(settings(), { allowed: [ALICE], admission: { [CHAT]: { unlistedAddressed: cell } } })
    const basis: MandateBasis = { via: 'admission', cell: 'unlistedAddressed', source: SOURCE,
      scope: recordScope(openScope(CHAT, true)), row: CHAT, addressed: 'mention' }
    const value = mandate('explicit', basis, GUEST)
    expect(policyOf(table('explicit')).revalidate(value)).toBe(true)
    expect(policyOf(table('inferred')).revalidate(value)).toBe(false)
    expect(policyOf(table('ignore')).revalidate(value)).toBe(false)
  })
  // docs/002 "Revalidation": removing a sender from the list can revoke a Mandate accepted through the listed cell.
  it('invalidates a listed-cell Mandate when its sender is removed from the list', () => {
    const basis: MandateBasis = { via: 'admission', cell: 'listedUnaddressed', source: SOURCE,
      scope: recordScope(openScope(CHAT, true)), row: CHAT }
    const value = mandate('inferred', basis, MEMBER)
    expect(policyOf(settings()).revalidate(value)).toBe(true)
    expect(policyOf(withPart(settings(), { allowed: [], admission: {} })).revalidate(value)).toBe(false)
  })
  // docs/002 "Revalidation": a bot's Mandate requires it to remain on the bot list, and inferred ones need auto.
  it('invalidates a bot Mandate when the bot leaves the bot list or accept mode leaves auto', () => {
    const withBot = withPart(settings(), { allowed: [ALICE], bots: [BOT_ENTRY], admission: {} })
    const basis: MandateBasis = { via: 'bot', source: SOURCE, scope: recordScope(openScope()), row: CHAT,
      sender: 'Alerts', addressed: 'mention', observation: { mode: 'auto' } }
    const value = mandate('inferred', basis, BOT)
    expect(policyOf(withBot).revalidate(value)).toBe(true)
    expect(policyOf(withPart(withBot, { allowed: [ALICE], bots: [], admission: {} })).revalidate(value)).toBe(false)
    expect(policyOf(withMode(withBot, 'observe')).revalidate(value)).toBe(false)
  })
  // docs/002 "Revalidation": inferred table Mandates also need auto mode and enabled matched rules.
  it('requires auto mode and enabled matched rules for an inferred admission Mandate', () => {
    const table = (rules: typeof RULES) => ({
      eval: { mode: 'auto' },
      policy: { rules, sources: { [SOURCE]: { allowed: [ALICE],
        admission: { [CHAT]: { unlistedUnaddressed: 'inferred' } } } } },
    })
    const inferred = settings(table(RULES))
    const basis: MandateBasis = { via: 'admission', cell: 'unlistedUnaddressed', source: SOURCE,
      scope: recordScope(openScope(CHAT, true)), row: CHAT, rules: ['copy'], observation: { mode: 'auto' } }
    const value = mandate('inferred', basis, GUEST)
    expect(policyOf(inferred).revalidate(value)).toBe(true)
    expect(policyOf(withMode(inferred, 'observe')).revalidate(value)).toBe(false)
    const disabled = withRules(inferred, [{ ...RULES[0]!, enabled: false }, RULES[1]!])
    expect(policyOf(disabled).revalidate(value)).toBe(false)
  })
})

describe('assessmentOutcome', () => {
  const settled = { implementation_requested: true, target_basis: 'specified', requires_design_decision: false, evidence: 'asked' }
  const judged = (value: Settings, matched = true) =>
    value.policy.rules.filter(rule => rule.enabled).map(rule => ({ rule_id: rule.id, matched, reason: 'judged' }))
  const assessment = (value: Settings, overrides: Partial<Assessment> = {}): Assessment => ({
    decision: 'accept', rule_assessments: judged(value), direction: settled,
    title: 'Fix', scope: 'small', reason: 'asked', intent_evidence: 'quote', worktree_name: 'fix-copy', ...overrides,
  })

  // docs/002 "Accept mode and rules": each assessment judges every enabled rule exactly once.
  it('requires exactly one judgement for every enabled rule', () => {
    const value = settings()
    expect(() => assessmentOutcome(assessment(value, { rule_assessments: judged(value).slice(1) }), value, 'inferred'))
      .toThrow('Exactly one assessment for every enabled rule')
    expect(() => assessmentOutcome(assessment(value, {
      rule_assessments: [...judged(value), { rule_id: 'unknown', matched: true, reason: 'x' }],
    }), value, 'inferred')).toThrow('Exactly one assessment for every enabled rule')
    expect(() => assessmentOutcome(assessment(value, {
      rule_assessments: [judged(value)[0]!, judged(value)[0]!],
    }), value, 'inferred')).toThrow('Exactly one assessment for every enabled rule')
    // A disabled rule is not an enabled rule, so judging it is not allowed either.
    const disabled = withRules(value, [{ ...RULES[0]!, enabled: false }, RULES[1]!])
    expect(() => assessmentOutcome(assessment(disabled, {
      rule_assessments: RULES.map(rule => ({ rule_id: rule.id, matched: true, reason: 'judged' })),
    }), disabled, 'inferred')).toThrow('Exactly one assessment for every enabled rule')
  })
  // docs/002 "Accept mode and rules": a proactive accept requires at least one matching rule.
  it('rejects an accept with no matching enabled rule', () => {
    const value = settings()
    expect(assessmentOutcome(assessment(value, { rule_assessments: judged(value, false) }), value, 'inferred'))
      .toMatchObject({ kind: 'ignore', reason: { code: 'noRuleMatched' } })
  })
  // docs/002 "Routing candidates": a settled implementation target without open design decisions is required.
  it('rejects an accept whose direction is not settled', () => {
    const value = settings()
    for (const direction of [
      { ...settled, requires_design_decision: true },
      { ...settled, target_basis: 'undetermined' },
      { ...settled, implementation_requested: false },
    ]) {
      expect(assessmentOutcome(assessment(value, { direction }), value, 'inferred'))
        .toMatchObject({ kind: 'ignore', reason: { code: 'directionUnsettled' } })
    }
  })
  // docs/002 "Routing candidates": acceptance requires evidence of implementation intent.
  it('throws when an accept omits intent evidence', () => {
    const value = settings()
    expect(() => assessmentOutcome(assessment(value, { intent_evidence: null }), value, 'inferred'))
      .toThrow('Acceptance requires intent_evidence')
  })
  // docs/002 "Accept mode": observe records a positive inferred assessment as ignore marked "would accept".
  it('records a positive inferred assessment as would-accept in observe mode', () => {
    const observe = withMode(settings(), 'observe')
    expect(assessmentOutcome(assessment(observe), observe, 'inferred')).toMatchObject({
      kind: 'ignore',
      reason: { code: 'observed', values: { text: 'asked' } },
      audit: { would_accept: true, proposal: { title: 'Fix', scope: 'small', worktree_name: 'fix-copy' } },
    })
    // docs/002 "Accept mode": explicit requests work in every mode.
    expect(assessmentOutcome(assessment(observe), observe, 'explicit'))
      .toMatchObject({ kind: 'accept', rules: ['copy', 'visual'] })
  })
  // docs/002 "Accept mode": auto accepts a positive inferred assessment on its matched rules.
  it('accepts an inferred assessment in auto mode with only the matched rules', () => {
    const auto = settings()
    const outcome = assessmentOutcome(assessment(auto, {
      rule_assessments: [
        { rule_id: 'copy', matched: true, reason: 'typo' },
        { rule_id: 'visual', matched: false, reason: 'no visuals' },
      ],
      acknowledgement: 'on it',
    }), auto, 'inferred')
    expect(outcome).toMatchObject({
      kind: 'accept', title: 'Fix', scope: 'small', reason: 'asked', acknowledgement: 'on it',
      rules: ['copy'], name: 'fix-copy',
    })
  })
  // docs/002 "Accept mode": an ignore or unavailable assessment is passed through, still judged against every rule.
  it('passes non-accept decisions through with their audit', () => {
    const value = settings()
    expect(assessmentOutcome(assessment(value, { decision: 'ignore', reason: 'not ours' }), value, 'inferred'))
      .toMatchObject({ kind: 'ignore', reason: 'not ours', audit: { rule_assessments: judged(value) } })
    expect(assessmentOutcome(assessment(value, { decision: 'unavailable', reason: 'model down' }), value, 'inferred'))
      .toMatchObject({ kind: 'unavailable', reason: 'model down' })
    expect(() => assessmentOutcome(assessment(value, { decision: 'ignore', rule_assessments: [] }), value, 'inferred'))
      .toThrow('Exactly one assessment for every enabled rule')
  })
})

describe('policyVersion', () => {
  // docs/002 "Policy version": equal inputs produce the same version.
  it('is stable for the same settings', () => {
    expect(policyVersion(settings())).toBe(policyVersion(settings()))
  })
  // docs/002 "Policy version": Rules form the Policy version.
  it('changes when a rule instruction, name or enabled flag changes', () => {
    const base = settings()
    expect(policyVersion(withRules(base, [{ ...RULES[0]!, instruction: 'Fix typos only.' }, RULES[1]!])))
      .not.toBe(policyVersion(base))
    expect(policyVersion(withRules(base, [{ ...RULES[0]!, name: 'Copy only' }, RULES[1]!])))
      .not.toBe(policyVersion(base))
    expect(policyVersion(withRules(base, [{ ...RULES[0]!, enabled: false }, RULES[1]!])))
      .not.toBe(policyVersion(base))
  })
  // docs/002 "Policy version": the accept mode forms the Policy version.
  it('changes when the accept mode changes', () => {
    expect(policyVersion(withMode(settings(), 'observe'))).not.toBe(policyVersion(settings()))
  })
  // docs/002 "Policy version": each Source's Policy forms the version, including allowed, bot and admission entries.
  it('changes when a Source policy part changes', () => {
    const base = settings()
    expect(policyVersion(withPart(base, { allowed: [], admission: {} }))).not.toBe(policyVersion(base))
    expect(policyVersion(withPart(base, { allowed: [{ id: 'ou_alice', name: 'Alicia' }], admission: {} })))
      .not.toBe(policyVersion(base))
    expect(policyVersion(withPart(base, { allowed: [ALICE], bots: [BOT_ENTRY], admission: {} })))
      .not.toBe(policyVersion(base))
    expect(policyVersion(withPart(base, { allowed: [ALICE], admission: { [CHAT]: { unlistedAddressed: 'explicit' } } })))
      .not.toBe(policyVersion(base))
  })
  // docs/002 "Policy version": Source configuration is separate from Policy; policy.ts also excludes pause, models and concurrency.
  it('ignores settings that do not decide who may originate work', () => {
    const value = settings()
    const unrelated = {
      ...value,
      paused: true,
      executor: { ...value.executor, maxWorkers: 9 },
      eval: { ...value.eval, timeoutSeconds: 300 },
      sources: { [SOURCE]: { enabled: true, config: { pollSeconds: 600 } } },
    }
    expect(policyVersion(unrelated)).toBe(policyVersion(value))
  })
  // NOTE: version hashes `JSON.stringify` of the policy, so the insertion order of Source keys is part of the input.
  it('depends on the insertion order of the Sources map', () => {
    const feishu = { allowed: [ALICE], admission: {} }
    const ordered = settings({ policy: { rules: RULES, sources: { [SOURCE]: feishu, github: { allowed: [] } } } })
    const reversed = settings({ policy: { rules: RULES, sources: { github: { allowed: [] }, [SOURCE]: feishu } } })
    expect(policyVersion(ordered)).not.toBe(policyVersion(reversed))
  })
})

describe('policyEffects', () => {
  const at = recordScope(openScope(CHAT, true))
  const scope = () => sourceScope
  const listed = (rules: string[]) => mandate('inferred', { via: 'listed', source: SOURCE, scope: at, rules, observation: { mode: 'auto' } }, MEMBER)

  // docs/002 "Policy version": a matched rule changed, including its new text.
  it('reports a changed rule only to tickets accepted under it', () => {
    const old = settings()
    const now = withRules(old, [{ ...RULES[0]!, instruction: 'Fix typos only.' }, RULES[1]!])
    const effects = policyEffects([ticket('t-copy', listed(['copy'])), ticket('t-visual', listed(['visual']))], old, now, scope)
    expect(effects.get('t-copy')).toEqual({
      rules: [{ id: 'copy', name: 'Copy fixes', change: 'changed', instruction: 'Fix typos only.' }],
    })
    expect(effects.has('t-visual')).toBe(false)
  })
  // docs/002 "Policy version": a matched rule "no longer applies".
  it('reports a disabled or deleted matched rule as disabled', () => {
    const old = settings()
    const copy = ticket('t-copy', listed(['copy']))
    const disabled = withRules(old, [{ ...RULES[0]!, enabled: false }, RULES[1]!])
    const deleted = withRules(old, [RULES[1]!])
    expect(policyEffects([copy], old, disabled, scope).get('t-copy'))
      .toEqual({ rules: [{ id: 'copy', name: 'Copy fixes', change: 'disabled' }] })
    expect(policyEffects([copy], old, deleted, scope).get('t-copy'))
      .toEqual({ rules: [{ id: 'copy', name: 'Copy fixes', change: 'disabled' }] })
  })
  // docs/002 "Policy version": "Unaffected Tickets receive no notice."
  it('leaves a ticket out when an unrelated Source policy part changes', () => {
    const old = settings({ policy: { rules: RULES, sources: {
      [SOURCE]: { allowed: [ALICE], admission: {} }, github: { allowed: [{ id: 'alice' }] },
    } } })
    const now = withSource(old, 'github', { allowed: [], admission: {} })
    const value = mandate('explicit', { via: 'addressed', addressed: 'mention', source: SOURCE, scope: at }, MEMBER)
    expect(policyEffects([ticket('t', value)], old, now, scope).size).toBe(0)
  })
  // docs/002 "Policy version": "the requester may no longer start work".
  it('reports that the requester may no longer start work when removed from the allowed list', () => {
    const old = settings()
    const now = withPart(old, { allowed: [], admission: {} })
    const value = mandate('explicit', { via: 'addressed', addressed: 'mention', source: SOURCE, scope: at }, MEMBER)
    expect(policyEffects([ticket('t', value)], old, now, scope).get('t'))
      .toEqual({ requesterAllowed: false, requester: MEMBER })
  })
  // docs/002 "Policy version": "proactive work is no longer accepted, for example because the mode changed from auto".
  it('reports that proactive work is no longer accepted when accept mode leaves auto', () => {
    const auto = settings()
    const observe = withMode(auto, 'observe')
    const explicit = mandate('explicit', { via: 'addressed', addressed: 'mention', source: SOURCE, scope: at }, MEMBER)
    const effects = policyEffects([ticket('t-inferred', listed(['copy'])), ticket('t-explicit', explicit)], auto, observe, scope)
    expect(effects.get('t-inferred')).toEqual({ proactive: false })
    expect(effects.has('t-explicit')).toBe(false)
  })
  // docs/002 "Policy version": a weakened admission cell is reported as the requester losing authorization.
  it('reports a weaker admission cell as the requester losing authorization', () => {
    const table = (cell: 'inferred' | 'ignore') =>
      withPart(settings(), { allowed: [ALICE], admission: { [CHAT]: { unlistedUnaddressed: cell } } })
    const value = mandate('inferred', { via: 'admission', cell: 'unlistedUnaddressed', source: SOURCE, scope: at,
      row: CHAT, rules: ['copy'], observation: { mode: 'auto' } }, GUEST)
    expect(policyEffects([ticket('t', value)], table('inferred'), table('inferred'), scope).size).toBe(0)
    expect(policyEffects([ticket('t', value)], table('inferred'), table('ignore'), scope).get('t'))
      .toEqual({ requesterAllowed: false, requester: GUEST })
  })
})
