import { describe, expect, it } from 'vitest'
import {
  applyDelta,
  dueForeshadow,
  findCharacter,
  realmLabel,
  stalledForeshadow,
  validateDelta,
} from '../src/novel/checks.ts'
import type { CheckIssue } from '../src/novel/checks.ts'
import {
  BibleSchema,
  CharactersSchema,
  ContractSchema,
  DeltaSchema,
  ForeshadowsSchema,
  ItemsSchema,
  PacingSchema,
  PlanSchema,
  PowerSchema,
  SecretsSchema,
  TimelineSchema,
  WorldSchema,
} from '../src/novel/schemas.ts'
import type { Canon, Character, Contract, Delta, Foreshadow } from '../src/novel/schemas.ts'

const TEXT = '林远服下一颗回春丹，随后踏入青云宗山门。玉简在怀中微微发烫。'
const Q_DAN = '服下一颗回春丹'
const Q_JADE = '玉简在怀中微微发烫'

/** A minimal but complete canon: 3 realms, a protagonist, a dead villain, two items, two locations 3 days apart, one open foreshadow, one secret. */
function makeCanon(): Canon {
  return {
    bible: {
      premise: '少年林远因祖传玉简踏上修仙路',
      sellingPoints: ['玉简认主'],
      protagonistId: 'c_lin',
      goldenFinger: { name: '玉简', rules: ['认主后可观想功法'], limits: ['每日一次'], growth: '随修为解锁' },
      style: { pov: '第三人称', rules: ['短句为主'], banned: ['综上所述'] },
      taboos: ['不写圣母'],
      compass: { endgame: '飞升上界', longLines: ['玉简来历'] },
    },
    power: {
      realms: [
        { id: 'lianqi', name: '炼气', order: 1, stages: ['初期', '中期', '后期', '大圆满'], abilities: [], breakthrough: { requires: [], risk: '' } },
        { id: 'zhuji', name: '筑基', order: 2, stages: ['初期', '中期', '后期'], abilities: [], breakthrough: { requires: [], risk: '' } },
        { id: 'jindan', name: '金丹', order: 3, stages: ['初期', '中期', '后期'], abilities: [], breakthrough: { requires: [], risk: '' } },
      ],
      crossRealmMaxGap: 1,
    },
    characters: [
      { id: 'c_lin', name: '林远', aliases: ['小林'], role: 'protagonist', realm: { id: 'lianqi', stage: 0 }, status: 'alive', location: '青石镇', anchors: ['坚韧'], relations: [], knows: [], firstCh: 1, lastSeenCh: 1 },
      { id: 'c_su', name: '苏婉', aliases: [], role: 'ally', status: 'alive', anchors: [], relations: [], knows: [], firstCh: 1, lastSeenCh: 1 },
      { id: 'c_zhao', name: '赵乾', aliases: [], role: 'villain', status: 'dead', anchors: [], relations: [], knows: [], firstCh: 1, lastSeenCh: 1 },
    ],
    items: [
      { id: 'i_dan', name: '回春丹', kind: '丹药', owner: 'c_lin', qty: 3, state: 'intact', gotCh: 1 },
      { id: 'i_sword', name: '青锋剑', kind: '法宝', owner: 'c_lin', qty: 1, state: 'intact', gotCh: 1 },
    ],
    world: {
      factions: [],
      locations: [
        { id: 'l_town', name: '青石镇', region: '东境', note: '' },
        { id: 'l_sect', name: '青云宗', region: '东境', note: '' },
      ],
      routes: [{ from: 'l_town', to: 'l_sect', days: 3 }],
    },
    foreshadow: [
      { id: 'f_jade', kind: 'foreshadow', content: '玉简来历', plantedCh: 1, dueBy: 5, priority: 'high', status: 'open', lastAdvancedCh: 1 },
    ],
    secrets: [{ id: 's_origin', truth: '林远的血脉来自上古', knownBy: [] }],
    timeline: [{ ch: 1, dayFrom: 0, dayTo: 2, location: '青石镇' }],
    plan: {
      volumes: [{ n: 1, title: '第一卷', goal: '入门' }],
      arcs: [{ n: 1, volume: 1, title: '初入宗门', template: '成长突破', goal: '拜入宗门', chapters: 10, status: 'writing' }],
    },
    pacing: [{ ch: 1, arc: 1, coolPoint: '获宝', hook: '悬念' }],
  }
}

function canonWith(edit: (c: Canon) => void): Canon {
  const c = makeCanon()
  edit(c)
  return c
}

const lin = (c: Canon): Character => c.characters.find((x) => x.id === 'c_lin')!
const su = (c: Canon): Character => c.characters.find((x) => x.id === 'c_su')!

function makeContract(patch: Record<string, unknown> = {}): Contract {
  return ContractSchema.parse({
    n: 2,
    title: '初入宗门',
    pov: 'c_lin',
    goal: '拜入青云宗',
    beats: ['林远抵达山门', '守门弟子刁难', '玉简异动'],
    appearing: ['c_lin'],
    location: '青云宗',
    coolPoint: { type: '打脸', payoff: '守门弟子认错' },
    hook: { type: '悬念', text: '玉简异动的源头' },
    foreshadow: { plant: [], advance: [], resolve: [] },
    ...patch,
  })
}

/** A fully legal chapter 2 against the base canon: one consume, one advance, travel exactly 3 days. */
const BASE_DELTA = {
  appeared: ['c_lin'],
  items: [{ op: 'consume', id: 'i_dan', qty: 1, quote: Q_DAN }],
  foreshadow: [{ op: 'advance', id: 'f_jade', quote: Q_JADE }],
  time: { dayFrom: 3, dayTo: 5 },
  location: '青云宗',
  summary: '林远经三日路程抵达青云宗山门，服下一颗回春丹调息，玉简异动被他察觉。',
  coolPoint: '揭秘',
  hook: '悬念',
}

function makeDelta(patch: Record<string, unknown> = {}): Delta {
  return DeltaSchema.parse({ ...BASE_DELTA, ...patch })
}

function check(delta: Delta, opts: { canon?: Canon; contract?: Contract; text?: string } = {}): CheckIssue[] {
  return validateDelta(opts.canon ?? makeCanon(), opts.contract ?? makeContract(), delta, opts.text ?? TEXT, 2)
}

const codes = (issues: CheckIssue[]): string[] => issues.map((i) => i.code)

function fs(id: string, patch: Partial<Foreshadow>): Foreshadow {
  return {
    id,
    kind: 'foreshadow',
    content: id,
    plantedCh: 1,
    priority: 'mid',
    status: 'open',
    lastAdvancedCh: 1,
    ...patch,
  }
}

describe('test canon', () => {
  it('passes every canon schema', () => {
    const c = makeCanon()
    expect(() => {
      BibleSchema.parse(c.bible)
      PowerSchema.parse(c.power)
      CharactersSchema.parse(c.characters)
      ItemsSchema.parse(c.items)
      WorldSchema.parse(c.world)
      ForeshadowsSchema.parse(c.foreshadow)
      SecretsSchema.parse(c.secrets)
      TimelineSchema.parse(c.timeline)
      PlanSchema.parse(c.plan)
      PacingSchema.parse(c.pacing)
    }).not.toThrow()
  })
})

describe('validateDelta', () => {
  it('returns no issues for a fully legal delta', () => {
    expect(check(makeDelta())).toEqual([])
  })

  it('quote: flags a quote that is not in the chapter text', () => {
    const d = makeDelta({ characterChanges: [{ id: 'c_lin', location: '青云宗', quote: '这句话不在正文里' }] })
    expect(codes(check(d))).toContain('quote')
  })

  it('quote: folds full-width quotes and whitespace before matching', () => {
    const d = makeDelta({ characterChanges: [{ id: 'c_lin', quote: '“走 吧，快点”' }] })
    expect(codes(check(d, { text: TEXT + '林远说："走吧，快点"。' }))).not.toContain('quote')
  })

  it('unknownCharacter: flags an appeared id that exists nowhere', () => {
    expect(codes(check(makeDelta({ appeared: ['c_ghost'] })))).toContain('unknownCharacter')
  })

  it('unknownCharacter: accepts an id introduced by this chapter', () => {
    const d = makeDelta({
      appeared: ['c_lin', 'c_new'],
      newCharacters: [{ id: 'c_new', name: '新人', role: 'minor', quote: Q_DAN }],
    })
    expect(codes(check(d))).not.toContain('unknownCharacter')
  })

  it('duplicateId: flags a new character whose id already exists', () => {
    const d = makeDelta({ newCharacters: [{ id: 'c_lin', name: '新人', role: 'minor', quote: Q_DAN }] })
    expect(codes(check(d))).toContain('duplicateId')
  })

  it('duplicateId: flags a gain of an existing item id under a different name', () => {
    const d = makeDelta({ items: [{ op: 'gain', id: 'i_dan', name: '别的丹', kind: '丹药', qty: 1, quote: Q_DAN }] })
    expect(codes(check(d))).toContain('duplicateId')
  })

  it('duplicateId: a gain of an existing item under its own name is fine', () => {
    const d = makeDelta({ items: [{ op: 'gain', id: 'i_dan', name: '回春丹', kind: '丹药', qty: 1, quote: Q_DAN }] })
    expect(codes(check(d))).not.toContain('duplicateId')
  })

  it('duplicateName: flags a new character named like an existing one', () => {
    const d = makeDelta({ newCharacters: [{ id: 'c_new', name: '苏婉', role: 'minor', quote: Q_DAN }] })
    expect(codes(check(d))).toContain('duplicateName')
  })

  it('duplicateName: flags a new character named like an existing alias', () => {
    const d = makeDelta({ newCharacters: [{ id: 'c_new', name: '小林', role: 'minor', quote: Q_DAN }] })
    expect(codes(check(d))).toContain('duplicateName')
  })

  it('duplicateName: a fresh name is fine', () => {
    const d = makeDelta({ newCharacters: [{ id: 'c_new', name: '新人', role: 'minor', quote: Q_DAN }] })
    expect(codes(check(d))).not.toContain('duplicateName')
  })

  it('deadActs: flags a dead character who appears without being revived', () => {
    expect(codes(check(makeDelta({ appeared: ['c_lin', 'c_zhao'] })))).toContain('deadActs')
  })

  it('deadActs: allowed when the contract names the dead character', () => {
    const d = makeDelta({ appeared: ['c_lin', 'c_zhao'] })
    expect(codes(check(d, { contract: makeContract({ allowDead: ['c_zhao'] }) }))).not.toContain('deadActs')
  })

  it('deadActs: not flagged when this chapter revives him to alive', () => {
    const d = makeDelta({
      appeared: ['c_lin', 'c_zhao'],
      characterChanges: [{ id: 'c_zhao', status: 'alive', quote: Q_DAN }],
    })
    expect(codes(check(d))).not.toContain('deadActs')
  })

  it('unknownRealm: flags a realm id missing from the power table', () => {
    const d = makeDelta({ characterChanges: [{ id: 'c_lin', realm: { id: 'nope', stage: 0 }, quote: Q_DAN }] })
    expect(codes(check(d))).toContain('unknownRealm')
  })

  it('unknownRealm: flags a stage beyond the realm stages', () => {
    const d = makeDelta({ characterChanges: [{ id: 'c_lin', realm: { id: 'lianqi', stage: 4 }, quote: Q_DAN }] })
    expect(codes(check(d))).toContain('unknownRealm')
  })

  it('unknownRealm: a valid realm position is fine', () => {
    const d = makeDelta({ characterChanges: [{ id: 'c_lin', realm: { id: 'lianqi', stage: 0 }, quote: Q_DAN }] })
    expect(codes(check(d))).not.toContain('unknownRealm')
  })

  it('realmDrop: flags a drop without a reason', () => {
    const canon = canonWith((c) => { lin(c).realm = { id: 'zhuji', stage: 1 } })
    const d = makeDelta({ characterChanges: [{ id: 'c_lin', realm: { id: 'lianqi', stage: 0 }, quote: Q_DAN }] })
    expect(codes(check(d, { canon }))).toContain('realmDrop')
  })

  it('realmDrop: a drop with a stated reason is fine', () => {
    const canon = canonWith((c) => { lin(c).realm = { id: 'zhuji', stage: 1 } })
    const d = makeDelta({
      characterChanges: [{ id: 'c_lin', realm: { id: 'lianqi', stage: 0 }, realmDropReason: '被封印修为', quote: Q_DAN }],
    })
    expect(codes(check(d, { canon }))).not.toContain('realmDrop')
  })

  it('realmJump: flags a one-chapter climb of two major realms', () => {
    const d = makeDelta({
      characterChanges: [{ id: 'c_lin', realm: { id: 'jindan', stage: 0 }, quote: Q_DAN }],
    })
    expect(codes(check(d, { contract: makeContract({ plannedChanges: ['突破金丹'] }) }))).toContain('realmJump')
  })

  it('realmJump: flags a same-realm stage climb of more than two', () => {
    const d = makeDelta({
      characterChanges: [{ id: 'c_lin', realm: { id: 'lianqi', stage: 3 }, quote: Q_DAN }],
    })
    expect(codes(check(d, { contract: makeContract({ plannedChanges: ['修炼至大圆满'] }) }))).toContain('realmJump')
  })

  it('realmJump: flags a non-protagonist climbing more than one major realm', () => {
    const canon = canonWith((c) => { su(c).realm = { id: 'lianqi', stage: 0 } })
    const d = makeDelta({
      characterChanges: [{ id: 'c_su', realm: { id: 'jindan', stage: 0 }, quote: Q_DAN }],
    })
    expect(codes(check(d, { canon }))).toContain('realmJump')
  })

  it('realmJump: flags a protagonist rise that the contract did not plan', () => {
    const d = makeDelta({
      characterChanges: [{ id: 'c_lin', realm: { id: 'zhuji', stage: 0 }, quote: Q_DAN }],
    })
    expect(codes(check(d))).toContain('realmJump')
  })

  it('realmJump: a planned one-step rise within two stages is fine', () => {
    const d = makeDelta({
      characterChanges: [{ id: 'c_lin', realm: { id: 'lianqi', stage: 2 }, quote: Q_DAN }],
    })
    expect(codes(check(d, { contract: makeContract({ plannedChanges: ['修炼至后期'] }) }))).not.toContain('realmJump')
  })

  it('unknownItem: flags a consume of an unknown item id', () => {
    const d = makeDelta({ items: [{ op: 'consume', id: 'i_nope', qty: 1, quote: Q_DAN }] })
    expect(codes(check(d))).toContain('unknownItem')
  })

  it('unknownItem: flags a new item gained without a name', () => {
    const d = makeDelta({ items: [{ op: 'gain', id: 'i_new', kind: '材料', qty: 1, quote: Q_DAN }] })
    expect(codes(check(d))).toContain('unknownItem')
  })

  it('unknownItem: a known item consumed is fine', () => {
    const d = makeDelta({ items: [{ op: 'consume', id: 'i_dan', qty: 1, quote: Q_DAN }] })
    expect(codes(check(d))).not.toContain('unknownItem')
  })

  it('itemGone: flags an operation on a destroyed item', () => {
    const canon = canonWith((c) => { c.items.find((i) => i.id === 'i_sword')!.state = 'destroyed' })
    const d = makeDelta({ items: [{ op: 'damage', id: 'i_sword', quote: Q_DAN }] })
    expect(codes(check(d, { canon }))).toContain('itemGone')
  })

  it('itemGone: an intact item is fine', () => {
    const d = makeDelta({ items: [{ op: 'damage', id: 'i_sword', quote: Q_DAN }] })
    expect(codes(check(d))).not.toContain('itemGone')
  })

  it('itemQty: flags consuming more than the item quantity', () => {
    const d = makeDelta({ items: [{ op: 'consume', id: 'i_dan', qty: 5, quote: Q_DAN }] })
    expect(codes(check(d))).toContain('itemQty')
  })

  it('itemQty: consuming within the quantity is fine', () => {
    const d = makeDelta({ items: [{ op: 'consume', id: 'i_dan', qty: 1, quote: Q_DAN }] })
    expect(codes(check(d))).not.toContain('itemQty')
  })

  it('itemOwner: flags a transfer to an unknown holder', () => {
    const d = makeDelta({ items: [{ op: 'transfer', id: 'i_sword', owner: 'c_ghost', quote: Q_DAN }] })
    expect(codes(check(d))).toContain('itemOwner')
  })

  it('itemOwner: a transfer to a known character or to none is fine', () => {
    const d = makeDelta({
      items: [
        { op: 'transfer', id: 'i_sword', owner: 'c_su', quote: Q_DAN },
        { op: 'transfer', id: 'i_dan', owner: 'none', quote: Q_DAN },
      ],
    })
    expect(codes(check(d))).not.toContain('itemOwner')
  })

  it('timeBack: flags a non-flashback chapter starting before the previous one ended', () => {
    const d = makeDelta({ time: { dayFrom: 1, dayTo: 3 } })
    expect(codes(check(d))).toContain('timeBack')
  })

  it('timeBack: flags a chapter that ends before it starts', () => {
    const d = makeDelta({ time: { dayFrom: 5, dayTo: 4 } })
    expect(codes(check(d))).toContain('timeBack')
  })

  it('timeBack: a flashback may start earlier than the previous chapter ended', () => {
    const d = makeDelta({ time: { dayFrom: 1, dayTo: 3, flashback: true } })
    expect(codes(check(d))).not.toContain('timeBack')
  })

  it('travel: flags a journey shorter than the route', () => {
    const d = makeDelta({ time: { dayFrom: 2, dayTo: 4 } })
    expect(codes(check(d))).toContain('travel')
  })

  it('travel: a journey as long as the route is fine', () => {
    expect(codes(check(makeDelta()))).not.toContain('travel')
  })

  it('travel: a flashback is exempt from the route check', () => {
    const d = makeDelta({ time: { dayFrom: 0, dayTo: 1, flashback: true } })
    expect(codes(check(d))).not.toContain('travel')
  })

  it('unknownForeshadow: flags advancing an id that does not exist', () => {
    const d = makeDelta({ foreshadow: [{ op: 'advance', id: 'f_ghost', quote: Q_JADE }] })
    expect(codes(check(d))).toContain('unknownForeshadow')
  })

  it('unknownForeshadow: flags a plant with no content', () => {
    const d = makeDelta({ foreshadow: [{ op: 'plant', id: 'f_new', quote: Q_JADE }] })
    expect(codes(check(d))).toContain('unknownForeshadow')
  })

  it('unknownForeshadow: a plant with content and an advance of a known id are fine', () => {
    const d = makeDelta({
      foreshadow: [
        { op: 'plant', id: 'f_new', content: '三年之约', quote: Q_JADE },
        { op: 'advance', id: 'f_jade', quote: Q_JADE },
      ],
    })
    expect(codes(check(d))).not.toContain('unknownForeshadow')
  })

  it('resolvedAgain: flags resolving an already resolved foreshadow', () => {
    const canon = canonWith((c) => {
      c.foreshadow[0] = { ...c.foreshadow[0]!, status: 'resolved', resolvedCh: 1 }
    })
    const d = makeDelta({ foreshadow: [{ op: 'resolve', id: 'f_jade', quote: Q_JADE }] })
    expect(codes(check(d, { canon }))).toContain('resolvedAgain')
  })

  it('resolvedAgain: resolving an open foreshadow is fine', () => {
    const d = makeDelta({ foreshadow: [{ op: 'resolve', id: 'f_jade', quote: Q_JADE }] })
    expect(codes(check(d))).not.toContain('resolvedAgain')
  })

  it('unknownSecret: flags revealing a secret that does not exist', () => {
    const d = makeDelta({ secretsRevealed: [{ id: 's_ghost', toReader: true, to: [], quote: Q_DAN }] })
    expect(codes(check(d))).toContain('unknownSecret')
  })

  it('unknownSecret: revealing a known secret is fine', () => {
    const d = makeDelta({ secretsRevealed: [{ id: 's_origin', toReader: true, to: ['c_lin'], quote: Q_DAN }] })
    expect(codes(check(d))).not.toContain('unknownSecret')
  })
})

describe('applyDelta', () => {
  it('deep-copies and never mutates its input', () => {
    const canon = makeCanon()
    const before = structuredClone(canon)
    const next = applyDelta(canon, makeContract(), makeDelta(), 2, 1)
    expect(canon).toEqual(before)
    expect(next).not.toBe(canon)
    expect(next.characters).not.toBe(canon.characters)
  })

  it('appends new characters as alive with first and last seen at this chapter', () => {
    const d = makeDelta({
      newCharacters: [{
        id: 'c_new', name: '新人', aliases: ['小新'], role: 'minor', faction: '青云宗',
        realm: { id: 'lianqi', stage: 1 }, anchors: ['胆小'], quote: Q_DAN,
      }],
    })
    const row = applyDelta(makeCanon(), makeContract(), d, 2, 1).characters.find((x) => x.id === 'c_new')!
    expect(row).toMatchObject({
      name: '新人', aliases: ['小新'], role: 'minor', faction: '青云宗', realm: { id: 'lianqi', stage: 1 },
      anchors: ['胆小'], status: 'alive', firstCh: 2, lastSeenCh: 2, relations: [], knows: [],
    })
  })

  it('updates lastSeenCh for every appeared character', () => {
    const next = applyDelta(makeCanon(), makeContract(), makeDelta({ appeared: ['c_lin'] }), 2, 1)
    expect(lin(next).lastSeenCh).toBe(2)
  })

  it('overwrites realm, status and location from characterChanges', () => {
    const d = makeDelta({
      characterChanges: [{ id: 'c_su', realm: { id: 'lianqi', stage: 2 }, status: 'missing', location: '青云宗', quote: Q_DAN }],
    })
    const row = su(applyDelta(makeCanon(), makeContract(), d, 2, 1))
    expect(row).toMatchObject({ realm: { id: 'lianqi', stage: 2 }, status: 'missing', location: '青云宗' })
  })

  it('appends relationsAdd once and keeps an existing relation unchanged', () => {
    const canon = canonWith((c) => {
      su(c).relations = [{ to: 'c_lin', kind: '同门', since: 1 }]
    })
    const d = makeDelta({
      characterChanges: [{
        id: 'c_su',
        relationsAdd: [{ to: 'c_lin', kind: '同门' }, { to: 'c_zhao', kind: '仇敌' }, { to: 'c_zhao', kind: '仇敌' }],
        quote: Q_DAN,
      }],
    })
    const relations = su(applyDelta(canon, makeContract(), d, 2, 1)).relations
    expect(relations).toEqual([
      { to: 'c_lin', kind: '同门', since: 1 },
      { to: 'c_zhao', kind: '仇敌', since: 2 },
    ])
  })

  it('keeps relations within 40, dropping the oldest, and repairs a canon already over the cap', () => {
    const canon = canonWith((c) => {
      c.characters.find((x) => x.id === 'c_su')!.relations = Array.from({ length: 45 }, (_, i) => ({ to: 'c_lin', kind: `旧${i}`, since: 1 }))
    })
    const d = makeDelta({
      characterChanges: [{ id: 'c_su', relationsAdd: [{ to: 'c_zhao', kind: '仇敌' }], quote: Q_DAN }],
    })
    const relations = su(applyDelta(canon, makeContract(), d, 2, 1)).relations
    expect(relations).toHaveLength(40)
    expect(relations.at(-1)).toEqual({ to: 'c_zhao', kind: '仇敌', since: 2 })
    expect(relations[0]?.kind).toBe('旧6')
  })

  it('appends knowsAdd without duplicates', () => {
    const d = makeDelta({
      characterChanges: [{ id: 'c_su', knowsAdd: ['s_origin', 's_origin'], quote: Q_DAN }],
    })
    expect(su(applyDelta(makeCanon(), makeContract(), d, 2, 1)).knows).toEqual(['s_origin'])
  })

  it('keeps only secret ids in knows and repairs a canon already holding free text', () => {
    const canon = canonWith((c) => { c.characters.find((x) => x.id === 'c_su')!.knows = ['旧的自由文本事实', 's_origin'] })
    const d = makeDelta({
      characterChanges: [{ id: 'c_su', knowsAdd: ['又一条自由文本', 's_origin'], quote: Q_DAN }],
    })
    expect(su(applyDelta(canon, makeContract(), d, 2, 1)).knows).toEqual(['s_origin'])
  })

  it('gain of an existing item adds quantity, updates owner and restores intact state', () => {
    const canon = canonWith((c) => { c.items.find((i) => i.id === 'i_dan')!.state = 'damaged' })
    const d = makeDelta({ items: [{ op: 'gain', id: 'i_dan', qty: 2, owner: 'c_su', quote: Q_DAN }] })
    const row = applyDelta(canon, makeContract(), d, 2, 1).items.find((i) => i.id === 'i_dan')!
    expect(row).toMatchObject({ qty: 5, owner: 'c_su', state: 'intact' })
  })

  it('gain of a new item appends it with gotCh at this chapter', () => {
    const d = makeDelta({
      items: [{ op: 'gain', id: 'i_scroll', name: '功法残卷', kind: '功法', grade: '黄阶', owner: 'c_lin', qty: 1, quote: Q_DAN }],
    })
    const row = applyDelta(makeCanon(), makeContract(), d, 2, 1).items.find((i) => i.id === 'i_scroll')!
    expect(row).toEqual({
      id: 'i_scroll', name: '功法残卷', kind: '功法', grade: '黄阶', owner: 'c_lin', qty: 1, state: 'intact', gotCh: 2,
    })
  })

  it('consume reduces quantity and leaves the item intact while stock remains', () => {
    const d = makeDelta({ items: [{ op: 'consume', id: 'i_dan', qty: 1, quote: Q_DAN }] })
    const row = applyDelta(makeCanon(), makeContract(), d, 2, 1).items.find((i) => i.id === 'i_dan')!
    expect(row).toMatchObject({ qty: 2, state: 'intact' })
  })

  it('consume to zero marks the item consumed', () => {
    const d = makeDelta({ items: [{ op: 'consume', id: 'i_dan', qty: 3, quote: Q_DAN }] })
    const row = applyDelta(makeCanon(), makeContract(), d, 2, 1).items.find((i) => i.id === 'i_dan')!
    expect(row).toMatchObject({ qty: 0, state: 'consumed' })
  })

  it.each([
    ['destroy', 'destroyed'],
    ['damage', 'damaged'],
    ['lose', 'lost'],
  ] as const)('%s sets state to %s', (op, state) => {
    const d = makeDelta({ items: [{ op, id: 'i_sword', quote: Q_DAN }] })
    const row = applyDelta(makeCanon(), makeContract(), d, 2, 1).items.find((i) => i.id === 'i_sword')!
    expect(row.state).toBe(state)
  })

  it('transfer updates the owner', () => {
    const d = makeDelta({ items: [{ op: 'transfer', id: 'i_sword', owner: 'c_su', quote: Q_DAN }] })
    const row = applyDelta(makeCanon(), makeContract(), d, 2, 1).items.find((i) => i.id === 'i_sword')!
    expect(row.owner).toBe('c_su')
  })

  it('plant appends a foreshadow with default kind and priority', () => {
    const d = makeDelta({ foreshadow: [{ op: 'plant', id: 'f_new', content: '三年之约', quote: Q_JADE }] })
    const row = applyDelta(makeCanon(), makeContract(), d, 2, 1).foreshadow.find((f) => f.id === 'f_new')!
    expect(row).toEqual({
      id: 'f_new', kind: 'foreshadow', content: '三年之约', plantedCh: 2, lastAdvancedCh: 2, priority: 'mid', status: 'open',
    })
  })

  it('plant keeps an explicit kind, priority and dueBy', () => {
    const d = makeDelta({
      foreshadow: [{ op: 'plant', id: 'f_p', content: '决战之约', kind: 'promise', priority: 'high', dueBy: 9, quote: Q_JADE }],
    })
    const row = applyDelta(makeCanon(), makeContract(), d, 2, 1).foreshadow.find((f) => f.id === 'f_p')!
    expect(row).toMatchObject({ kind: 'promise', priority: 'high', dueBy: 9 })
  })

  it('plant of an existing id leaves that foreshadow unchanged', () => {
    const d = makeDelta({ foreshadow: [{ op: 'plant', id: 'f_jade', content: '别的内容', quote: Q_JADE }] })
    const row = applyDelta(makeCanon(), makeContract(), d, 2, 1).foreshadow.find((f) => f.id === 'f_jade')!
    expect(row.content).toBe('玉简来历')
  })

  it('advance sets status progressing and lastAdvancedCh', () => {
    const row = applyDelta(makeCanon(), makeContract(), makeDelta(), 2, 1).foreshadow.find((f) => f.id === 'f_jade')!
    expect(row).toMatchObject({ status: 'progressing', lastAdvancedCh: 2 })
  })

  it('resolve sets status resolved and resolvedCh', () => {
    const d = makeDelta({ foreshadow: [{ op: 'resolve', id: 'f_jade', quote: Q_JADE }] })
    const row = applyDelta(makeCanon(), makeContract(), d, 2, 1).foreshadow.find((f) => f.id === 'f_jade')!
    expect(row).toMatchObject({ status: 'resolved', resolvedCh: 2 })
  })

  it('defer sets status deferred and updates dueBy', () => {
    const d = makeDelta({ foreshadow: [{ op: 'defer', id: 'f_jade', dueBy: 8, quote: Q_JADE }] })
    const row = applyDelta(makeCanon(), makeContract(), d, 2, 1).foreshadow.find((f) => f.id === 'f_jade')!
    expect(row).toMatchObject({ status: 'deferred', dueBy: 8 })
  })

  it('secret revealed to the reader sets revealedToReaderCh, and a character who learns it knows it', () => {
    const d = makeDelta({ secretsRevealed: [{ id: 's_origin', toReader: true, to: ['c_lin'], quote: Q_DAN }] })
    const next = applyDelta(makeCanon(), makeContract(), d, 2, 1)
    const secret = next.secrets.find((s) => s.id === 's_origin')!
    expect(secret.revealedToReaderCh).toBe(2)
    expect(secret.knownBy).toContain('c_lin')
    expect(lin(next).knows).toContain('s_origin')
  })

  it('secret already revealed to the reader keeps its original chapter', () => {
    const canon = canonWith((c) => { c.secrets[0] = { ...c.secrets[0]!, revealedToReaderCh: 1 } })
    const d = makeDelta({ secretsRevealed: [{ id: 's_origin', toReader: true, to: [], quote: Q_DAN }] })
    expect(applyDelta(canon, makeContract(), d, 2, 1).secrets[0]?.revealedToReaderCh).toBe(1)
  })

  it('timeline entry omits the flashback key unless the chapter is a flashback', () => {
    const next = applyDelta(makeCanon(), makeContract(), makeDelta(), 2, 1)
    const entry = next.timeline.find((e) => e.ch === 2)!
    expect(entry).toEqual({ ch: 2, dayFrom: 3, dayTo: 5, location: '青云宗' })
    expect('flashback' in entry).toBe(false)
  })

  it('timeline entry records flashback true for a flashback chapter', () => {
    const d = makeDelta({ time: { dayFrom: 0, dayTo: 1, flashback: true } })
    const entry = applyDelta(makeCanon(), makeContract(), d, 2, 1).timeline.find((e) => e.ch === 2)!
    expect(entry.flashback).toBe(true)
  })

  it('pacing entry carries the chapter arc, cool point and hook', () => {
    const entry = applyDelta(makeCanon(), makeContract(), makeDelta(), 2, 1).pacing.find((p) => p.ch === 2)!
    expect(entry).toEqual({ ch: 2, arc: 1, coolPoint: '揭秘', hook: '悬念' })
  })

  it('applying the same chapter twice does not duplicate timeline or pacing entries', () => {
    const once = applyDelta(makeCanon(), makeContract(), makeDelta(), 2, 1)
    const twice = applyDelta(once, makeContract(), makeDelta(), 2, 1)
    expect(twice.timeline.filter((e) => e.ch === 2)).toHaveLength(1)
    expect(twice.pacing.filter((p) => p.ch === 2)).toHaveLength(1)
    expect(twice.timeline).toHaveLength(2)
    expect(twice.pacing).toHaveLength(2)
  })
})

describe('dueForeshadow', () => {
  it('returns active foreshadows due within two chapters, most important and most urgent first', () => {
    const canon = canonWith((c) => {
      c.foreshadow = [
        fs('a', { priority: 'low', dueBy: 3, status: 'open' }),
        fs('b', { priority: 'high', dueBy: 9, status: 'progressing' }),
        fs('c', { priority: 'high', dueBy: 4, status: 'open' }),
        fs('d', { priority: 'high', dueBy: 1, status: 'resolved', resolvedCh: 1 }),
        fs('e', { priority: 'high', dueBy: 2, status: 'deferred' }),
        fs('f', { priority: 'high', status: 'open' }),
        fs('g', { priority: 'high', dueBy: 20, status: 'open' }),
      ]
    })
    expect(dueForeshadow(canon, 2).map((f) => f.id)).toEqual(['c', 'a'])
  })

  it('includes a foreshadow due exactly two chapters ahead and excludes one due three ahead', () => {
    const canon = canonWith((c) => {
      c.foreshadow = [fs('x', { dueBy: 5, status: 'open' }), fs('y', { dueBy: 6, status: 'open' })]
    })
    expect(dueForeshadow(canon, 3).map((f) => f.id)).toEqual(['x'])
  })
})

describe('stalledForeshadow', () => {
  it('flags an active foreshadow not advanced for at least the gap', () => {
    const canon = canonWith((c) => {
      c.foreshadow = [fs('x', { lastAdvancedCh: 1, status: 'open' })]
    })
    expect(stalledForeshadow(canon, 31).map((f) => f.id)).toEqual(['x'])
  })

  it('does not flag a foreshadow still inside the gap', () => {
    const canon = canonWith((c) => {
      c.foreshadow = [fs('x', { lastAdvancedCh: 1, status: 'open' })]
    })
    expect(stalledForeshadow(canon, 30)).toEqual([])
  })

  it('ignores resolved foreshadows and honours a custom gap', () => {
    const canon = canonWith((c) => {
      c.foreshadow = [
        fs('r', { lastAdvancedCh: 1, status: 'resolved', resolvedCh: 1 }),
        fs('p', { lastAdvancedCh: 10, status: 'progressing' }),
      ]
    })
    expect(stalledForeshadow(canon, 16, 5).map((f) => f.id)).toEqual(['p'])
    expect(stalledForeshadow(canon, 16).map((f) => f.id)).toEqual([])
  })
})

describe('realmLabel', () => {
  const power = makeCanon().power

  it('joins realm name and stage name', () => {
    expect(realmLabel(power, { id: 'zhuji', stage: 1 })).toBe('筑基·中期')
  })

  it('reads no position as mortal', () => {
    expect(realmLabel(power, undefined)).toBe('凡人')
  })

  it('falls back to the raw id for an unknown realm and to the realm name for an out-of-range stage', () => {
    expect(realmLabel(power, { id: 'nope', stage: 0 })).toBe('nope')
    expect(realmLabel(power, { id: 'zhuji', stage: 9 })).toBe('筑基')
  })
})

describe('findCharacter', () => {
  const canon = makeCanon()

  it('finds by id, name and alias', () => {
    expect(findCharacter(canon, 'c_lin')?.id).toBe('c_lin')
    expect(findCharacter(canon, '林远')?.id).toBe('c_lin')
    expect(findCharacter(canon, '小林')?.id).toBe('c_lin')
  })

  it('returns undefined when nobody matches', () => {
    expect(findCharacter(canon, 'nobody')).toBeUndefined()
  })
})
