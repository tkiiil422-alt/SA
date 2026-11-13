/**
 * Incremental hard checks and the pure state transition for one chapter's delta.
 *
 * Nothing here touches the disk. `validateDelta` reports every rule a chapter breaks; `applyDelta` writes the chapter
 * into a deep copy of the canon and never mutates its input.
 */
import type {
  Canon,
  Character,
  Contract,
  Delta,
  Foreshadow,
  Item,
  Power,
  RealmPos,
  TimelineEntry,
} from './schemas.ts'

export type CheckCode = 'quote' | 'unknownCharacter' | 'deadActs' | 'realmDrop' | 'realmJump' | 'unknownRealm'
  | 'unknownItem' | 'itemGone' | 'itemQty' | 'itemOwner' | 'timeBack' | 'travel' | 'unknownForeshadow'
  | 'resolvedAgain' | 'duplicateName' | 'duplicateId' | 'unknownSecret'

export interface CheckIssue { code: CheckCode; message: string }

export interface CheckOptions {
  /** How many major realms the protagonist may climb in one chapter. Default 1. */
  protagonistMaxMajorPerChapter?: number
}

const ITEM_GONE_STATES: readonly Item['state'][] = ['consumed', 'destroyed', 'lost']
const ACTIVE_FORESHADOW: readonly Foreshadow['status'][] = ['open', 'progressing']
const PRIORITY_RANK: Record<Foreshadow['priority'], number> = { high: 0, mid: 1, low: 2 }

/** Full-width quotes fold to half-width and every whitespace character goes. Applied to both sides of a quote match. */
function fold(text: string): string {
  return text.replace(/[“”「」『』＂]/g, '"').replace(/[‘’＇]/g, "'").replace(/\s+/g, '')
}

/** True when the folded quote, without its outer quote marks, is a non-empty substring of the folded body. */
function quoteInBody(body: string, quote: string): boolean {
  const needle = fold(quote).replace(/^["']+|["']+$/g, '')
  return needle.length > 0 && body.includes(needle)
}

function realmOf(power: Power, id: string) {
  return power.realms.find((r) => r.id === id)
}

interface Rank { order: number; stage: number }

function rankOf(power: Power, pos: RealmPos): Rank | undefined {
  const realm = realmOf(power, pos.id)
  return realm ? { order: realm.order, stage: pos.stage } : undefined
}

function compareRank(a: Rank, b: Rank): number {
  return a.order !== b.order ? a.order - b.order : a.stage - b.stage
}

function previousEntry(timeline: TimelineEntry[], n: number): TimelineEntry | undefined {
  let found: TimelineEntry | undefined
  for (const entry of timeline) {
    if (entry.ch < n && (found === undefined || entry.ch > found.ch)) found = entry
  }
  return found
}

/** Every rule a chapter's delta breaks against the canon. An empty array means the delta may be applied. */
export function validateDelta(
  canon: Canon,
  contract: Contract,
  delta: Delta,
  text: string,
  n: number,
  opts: CheckOptions = {},
): CheckIssue[] {
  const issues: CheckIssue[] = []
  const add = (code: CheckCode, message: string): void => {
    issues.push({ code, message })
  }
  const body = fold(text)
  const maxMajor = opts.protagonistMaxMajorPerChapter ?? 1
  const known = new Set<string>([...canon.characters.map((c) => c.id), ...delta.newCharacters.map((c) => c.id)])
  const items = new Map<string, Item>(canon.items.map((i): [string, Item] => [i.id, i]))
  const foreshadow = new Map<string, Foreshadow>(canon.foreshadow.map((f): [string, Foreshadow] => [f.id, f]))
  const nameOf = (id: string): string => canon.characters.find((c) => c.id === id)?.name ?? id
  const ownerKnown = (id: string): boolean => id === 'none' || known.has(id)
  const prev = previousEntry(canon.timeline, n)

  // quote: every quoted fact must be findable in the chapter text.
  const quotes = [
    ...delta.newCharacters.map((c) => c.quote),
    ...delta.characterChanges.map((c) => c.quote),
    ...delta.items.map((o) => o.quote),
    ...delta.foreshadow.map((o) => o.quote),
    ...delta.secretsRevealed.map((s) => s.quote),
  ]
  for (const quote of quotes) {
    if (!quoteInBody(body, quote)) add('quote', `第${n}章引文在正文中找不到：「${quote}」`)
  }

  // unknownCharacter: every referenced id exists in the canon or is introduced by this chapter.
  const refs: [string, string][] = []
  for (const id of delta.appeared) refs.push([id, '出场名单'])
  for (const change of delta.characterChanges) {
    refs.push([change.id, '角色变动'])
    for (const rel of change.relationsAdd) refs.push([rel.to, `${change.id}的关系`])
  }
  for (const s of delta.secretsRevealed) {
    for (const id of s.to) refs.push([id, `秘密 ${s.id} 的知情者`])
  }
  for (const [id, where] of refs) {
    if (!known.has(id)) add('unknownCharacter', `第${n}章${where}引用了不存在的角色 ${id}`)
  }

  // duplicateId / duplicateName: new characters must not collide with existing ones.
  const newIds = new Set<string>()
  for (const nc of delta.newCharacters) {
    if (newIds.has(nc.id) || canon.characters.some((c) => c.id === nc.id)) {
      add('duplicateId', `第${n}章新角色 id ${nc.id} 已存在`)
    }
    newIds.add(nc.id)
    if (canon.characters.some((c) => c.name === nc.name || c.aliases.includes(nc.name))) {
      add('duplicateName', `第${n}章新角色「${nc.name}」与已有角色重名`)
    }
  }
  for (const op of delta.items) {
    const item = items.get(op.id)
    if (op.op === 'gain' && item && op.name !== undefined && op.name !== item.name) {
      add('duplicateId', `第${n}章物品 id ${op.id} 已属于「${item.name}」，不能用于「${op.name}」`)
    }
  }

  // deadActs: a dead character appears only when allowed or revived in this chapter.
  for (const id of delta.appeared) {
    const c = canon.characters.find((x) => x.id === id)
    if (!c || c.status !== 'dead' || contract.allowDead.includes(id)) continue
    if (delta.characterChanges.some((x) => x.id === id && x.status === 'alive')) continue
    add('deadActs', `第${n}章已死角色${c.name}出场`)
  }

  // unknownRealm, realmDrop, realmJump: realm positions against the power table and the previous position.
  const realmKnown = (who: string, pos: RealmPos): boolean => {
    const realm = realmOf(canon.power, pos.id)
    if (realm && pos.stage < realm.stages.length) return true
    add('unknownRealm', `第${n}章${who}的境界 ${pos.id} 第 ${pos.stage} 阶不在境界表内`)
    return false
  }
  for (const nc of delta.newCharacters) {
    if (nc.realm) realmKnown(`新角色${nc.name}`, nc.realm)
  }
  for (const change of delta.characterChanges) {
    if (!change.realm || !realmKnown(nameOf(change.id), change.realm)) continue
    const char = canon.characters.find((c) => c.id === change.id)
    const from = char?.realm ? rankOf(canon.power, char.realm) : undefined
    const to = rankOf(canon.power, change.realm)
    if (!char || !from || !to) continue
    const direction = compareRank(to, from)
    if (direction < 0 && !change.realmDropReason) {
      add('realmDrop', `第${n}章${char.name}境界下降（${realmLabel(canon.power, char.realm)} → ${realmLabel(canon.power, change.realm)}）且未给出理由`)
    }
    const protagonist = char.id === canon.bible.protagonistId
    const orderJump = to.order - from.order > (protagonist ? maxMajor : 1)
    const stageJump = to.order === from.order && to.stage - from.stage > 2
    const unplannedRise = protagonist && direction > 0 && contract.plannedChanges.length === 0
    if (orderJump || stageJump || unplannedRise) {
      add('realmJump', `第${n}章${char.name}境界跳跃过大（${realmLabel(canon.power, char.realm)} → ${realmLabel(canon.power, change.realm)}）`)
    }
  }

  // unknownItem, itemGone, itemQty, itemOwner.
  for (const op of delta.items) {
    const item = items.get(op.id)
    if (op.op === 'gain') {
      if (!item && (!op.name || !op.kind)) add('unknownItem', `第${n}章新物品 ${op.id} 缺少名称或类别`)
      if (op.owner !== undefined && !ownerKnown(op.owner)) add('itemOwner', `第${n}章物品 ${op.id} 的持有人 ${op.owner} 不存在`)
      continue
    }
    if (!item) {
      add('unknownItem', `第${n}章物品 ${op.id} 不存在`)
      continue
    }
    if (ITEM_GONE_STATES.includes(item.state)) {
      add('itemGone', `第${n}章物品${item.name}已不存在（状态 ${item.state}）`)
      continue
    }
    if (op.op === 'consume' && op.qty > item.qty) {
      add('itemQty', `第${n}章消耗${item.name} ${op.qty} 件，但只剩 ${item.qty} 件`)
    }
    if (op.op === 'transfer' && op.owner !== undefined && !ownerKnown(op.owner)) {
      add('itemOwner', `第${n}章物品${item.name}转给了不存在的持有人 ${op.owner}`)
    }
  }

  // timeBack, travel.
  const { time } = delta
  if (time.dayTo < time.dayFrom) {
    add('timeBack', `第${n}章时间倒流：结束于第${time.dayTo}日，早于开始的第${time.dayFrom}日`)
  }
  if (!time.flashback && prev && time.dayFrom < prev.dayTo) {
    add('timeBack', `第${n}章从第${time.dayFrom}日开始，早于第${prev.ch}章结束的第${prev.dayTo}日`)
  }
  if (!time.flashback && prev) {
    const from = canon.world.locations.find((l) => l.name === prev.location)
    const to = canon.world.locations.find((l) => l.name === delta.location)
    const route = from && to
      ? canon.world.routes.find((r) => (r.from === from.id && r.to === to.id) || (r.from === to.id && r.to === from.id))
      : undefined
    if (route && time.dayTo - prev.dayTo < route.days) {
      add('travel', `第${n}章从「${prev.location}」到「${delta.location}」只用了 ${time.dayTo - prev.dayTo} 天，路程需要 ${route.days} 天`)
    }
  }

  // unknownForeshadow, resolvedAgain.
  for (const op of delta.foreshadow) {
    if (op.op === 'plant') {
      if (!op.content) add('unknownForeshadow', `第${n}章埋设伏笔 ${op.id} 缺少内容`)
      continue
    }
    const f = foreshadow.get(op.id)
    if (!f) {
      add('unknownForeshadow', `第${n}章伏笔 ${op.id} 不存在`)
      continue
    }
    if (op.op === 'resolve' && f.status === 'resolved') add('resolvedAgain', `第${n}章伏笔 ${op.id} 已经回收过`)
  }

  // unknownSecret.
  for (const s of delta.secretsRevealed) {
    if (!canon.secrets.some((x) => x.id === s.id)) add('unknownSecret', `第${n}章揭示了不存在的秘密 ${s.id}`)
  }

  return issues
}

/**
 * Applies one chapter's delta to a deep copy of the canon. Call only after `validateDelta` returned no issues.
 * Timeline and pacing entries for chapter `n` are replaced, so applying the same chapter twice is idempotent for them.
 * Item quantities are not idempotent (a `gain` adds again); callers restore a snapshot before re-applying.
 */
export function applyDelta(canon: Canon, _contract: Contract, delta: Delta, n: number, arc: number): Canon {
  const next = structuredClone(canon)
  // `knows` holds secret ids only. Extractors have written free-text facts here; drop anything that is not a secret
  // id, which also repairs a canon that an earlier version let fill up.
  const secretIds = new Set(next.secrets.map((s) => s.id))
  for (const c of next.characters) c.knows = c.knows.filter((id) => secretIds.has(id))
  // `relations` gains entries every chapter a character appears and was never trimmed; the protagonist passed the
  // schema's 40 after 67 chapters and the canon could not be written. Keep the most recent ones.
  const MAX_RELATIONS = 40
  const trimRelations = (c: Character): void => { if (c.relations.length > MAX_RELATIONS) c.relations = c.relations.slice(-MAX_RELATIONS) }
  for (const c of next.characters) trimRelations(c)
  const character = (id: string): Character | undefined => next.characters.find((c) => c.id === id)
  const item = (id: string): Item | undefined => next.items.find((i) => i.id === id)
  const foreshadow = (id: string): Foreshadow | undefined => next.foreshadow.find((f) => f.id === id)

  for (const nc of delta.newCharacters) {
    if (character(nc.id)) continue
    const row: Character = {
      id: nc.id,
      name: nc.name,
      aliases: [...nc.aliases],
      role: nc.role,
      anchors: [...nc.anchors],
      status: 'alive',
      relations: [],
      knows: [],
      firstCh: n,
      lastSeenCh: n,
    }
    if (nc.faction !== undefined) row.faction = nc.faction
    if (nc.realm !== undefined) row.realm = { ...nc.realm }
    next.characters.push(row)
  }

  for (const id of delta.appeared) {
    const c = character(id)
    if (c) c.lastSeenCh = n
  }

  for (const change of delta.characterChanges) {
    const c = character(change.id)
    if (!c) continue
    if (change.realm !== undefined) c.realm = { ...change.realm }
    if (change.status !== undefined) c.status = change.status
    if (change.location !== undefined) c.location = change.location
    for (const rel of change.relationsAdd) {
      if (!c.relations.some((r) => r.to === rel.to && r.kind === rel.kind)) {
        c.relations.push({ to: rel.to, kind: rel.kind, since: n })
      }
    }
    trimRelations(c)
    for (const id of change.knowsAdd) {
      if (secretIds.has(id) && !c.knows.includes(id)) c.knows.push(id)
    }
  }

  for (const op of delta.items) {
    const it = item(op.id)
    switch (op.op) {
      case 'gain': {
        if (it) {
          it.qty += op.qty
          if (op.owner !== undefined) it.owner = op.owner
          it.state = 'intact'
          break
        }
        const row: Item = {
          id: op.id,
          name: op.name ?? op.id,
          kind: op.kind ?? '其他',
          owner: op.owner ?? 'none',
          qty: op.qty,
          state: 'intact',
          gotCh: n,
        }
        if (op.grade !== undefined) row.grade = op.grade
        next.items.push(row)
        break
      }
      case 'consume':
        if (it) {
          it.qty = Math.max(0, it.qty - op.qty)
          if (it.qty === 0) it.state = 'consumed'
        }
        break
      case 'destroy':
        if (it) it.state = 'destroyed'
        break
      case 'damage':
        if (it) it.state = 'damaged'
        break
      case 'lose':
        if (it) it.state = 'lost'
        break
      case 'transfer':
        if (it && op.owner !== undefined) it.owner = op.owner
        break
    }
  }

  for (const op of delta.foreshadow) {
    const f = foreshadow(op.id)
    switch (op.op) {
      case 'plant': {
        if (f) break
        const row: Foreshadow = {
          id: op.id,
          kind: op.kind ?? 'foreshadow',
          content: op.content ?? op.id,
          plantedCh: n,
          lastAdvancedCh: n,
          priority: op.priority ?? 'mid',
          status: 'open',
        }
        if (op.dueBy !== undefined) row.dueBy = op.dueBy
        next.foreshadow.push(row)
        break
      }
      case 'advance':
        if (f) {
          f.status = 'progressing'
          f.lastAdvancedCh = n
        }
        break
      case 'resolve':
        if (f) {
          f.status = 'resolved'
          f.resolvedCh = n
        }
        break
      case 'defer':
        if (f) {
          f.status = 'deferred'
          if (op.dueBy !== undefined) f.dueBy = op.dueBy
        }
        break
    }
  }

  for (const s of delta.secretsRevealed) {
    const secret = next.secrets.find((x) => x.id === s.id)
    if (!secret) continue
    if (s.toReader && secret.revealedToReaderCh === undefined) secret.revealedToReaderCh = n
    for (const id of s.to) {
      const c = character(id)
      if (c && !c.knows.includes(s.id)) c.knows.push(s.id)
      if (!secret.knownBy.includes(id)) secret.knownBy.push(id)
    }
  }

  next.timeline = next.timeline.filter((e) => e.ch !== n)
  const entry: TimelineEntry = {
    ch: n,
    dayFrom: delta.time.dayFrom,
    dayTo: delta.time.dayTo,
    location: delta.location,
  }
  if (delta.time.flashback) entry.flashback = true
  next.timeline.push(entry)
  next.timeline.sort((a, b) => a.ch - b.ch)

  next.pacing = next.pacing.filter((p) => p.ch !== n)
  next.pacing.push({ ch: n, arc, coolPoint: delta.coolPoint, hook: delta.hook })
  next.pacing.sort((a, b) => a.ch - b.ch)

  return next
}

/** Open or progressing foreshadows due within two chapters of `n`, most important and most urgent first. */
export function dueForeshadow(canon: Canon, n: number): Foreshadow[] {
  return canon.foreshadow
    .filter((f) => ACTIVE_FORESHADOW.includes(f.status) && f.dueBy !== undefined && f.dueBy <= n + 2)
    .sort((a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || (a.dueBy ?? 0) - (b.dueBy ?? 0))
}

/** Open or progressing foreshadows not advanced for at least `gap` chapters as of `n`. */
export function stalledForeshadow(canon: Canon, n: number, gap = 30): Foreshadow[] {
  return canon.foreshadow.filter((f) => ACTIVE_FORESHADOW.includes(f.status) && n - f.lastAdvancedCh >= gap)
}

/** Human label for a realm position, e.g. `筑基·中期`. No position is `凡人`. */
export function realmLabel(power: Power, pos: RealmPos | undefined): string {
  if (!pos) return '凡人'
  const realm = realmOf(power, pos.id)
  if (!realm) return pos.id
  const stage = realm.stages[pos.stage]
  return stage ? `${realm.name}·${stage}` : realm.name
}

/** Finds a character by id first, then by name, then by alias. */
export function findCharacter(canon: Canon, idOrName: string): Character | undefined {
  return canon.characters.find((c) => c.id === idOrName)
    ?? canon.characters.find((c) => c.name === idOrName)
    ?? canon.characters.find((c) => c.aliases.includes(idOrName))
}
