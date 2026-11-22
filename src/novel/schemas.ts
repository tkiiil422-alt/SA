/**
 * The novel engine's data shapes: the canon files (the single source of truth for one book), the per-chapter contract,
 * the extraction delta and the review result.
 *
 * Every canon file is parsed with these schemas on read and on write, so a model can never leave a malformed fact on
 * disk. Model output (contract, delta, review) is parsed with the same schemas before code acts on it.
 */
import { z } from 'zod'

const Id = z.string().trim().min(1).max(64)
const Text = (max: number) => z.string().trim().max(max)
const Chapter = z.number().int().min(0)

export const GENRES = ['xianxia', 'xuanhuan'] as const
export const GenreSchema = z.enum(GENRES)
export type Genre = z.infer<typeof GenreSchema>
export const GENRE_LABELS: Record<Genre, string> = { xianxia: '仙侠', xuanhuan: '玄幻' }

export const COOL_POINTS = ['打脸', '突破', '获宝', '反杀', '扮猪吃虎', '揭秘', '收服', '碾压', '情感', '布局', '过渡'] as const
export const CoolPointSchema = z.enum(COOL_POINTS)
export type CoolPoint = z.infer<typeof CoolPointSchema>

export const HOOKS = ['悬念', '危机', '反转', '期待', '新目标'] as const
export const HookSchema = z.enum(HOOKS)
export type Hook = z.infer<typeof HookSchema>

export const ARC_TEMPLATES = ['成长突破', '竞技对抗', '秘境探索', '恩怨复仇', '宗门日常', '交易拍卖', '势力战争'] as const
export const ArcTemplateSchema = z.enum(ARC_TEMPLATES)
export type ArcTemplate = z.infer<typeof ArcTemplateSchema>

// --- book.json -------------------------------------------------------------------------------------------------------

export const BookPhaseSchema = z.enum(['setup', 'ready', 'writing', 'paused', 'done'])
export type BookPhase = z.infer<typeof BookPhaseSchema>

export const BookSchema = z.object({
  id: z.string().regex(/^b_[A-Za-z0-9]{1,32}$/),
  title: Text(60).min(1),
  genre: GenreSchema,
  idea: Text(4000),
  phase: BookPhaseSchema,
  chapterChars: z.tuple([z.number().int().min(500), z.number().int().max(20000)]),
  volumesPlanned: z.number().int().min(1).max(50),
  chaptersPerVolume: z.number().int().min(5).max(1000),
  /** The last committed chapter number; 0 before the first. */
  lastChapter: Chapter,
  /** Per-book model overrides, `provider/model` refs; absent means `novel.models` then `routing.worker`. */
  models: z.object({ writer: Text(200).optional() }).strict().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
}).strict()
export type Book = z.infer<typeof BookSchema>

// --- canon/bible.json ------------------------------------------------------------------------------------------------

export const BibleSchema = z.object({
  premise: Text(2000).min(1),
  sellingPoints: z.array(Text(200)).max(10),
  protagonistId: Id,
  goldenFinger: z.object({
    name: Text(60).min(1),
    rules: z.array(Text(200)).max(10),
    limits: z.array(Text(200)).max(10),
    growth: Text(500),
  }).strict(),
  style: z.object({
    pov: z.enum(['第三人称', '第一人称']),
    rules: z.array(Text(200)).max(20),
    banned: z.array(Text(40)).max(100),
  }).strict(),
  taboos: z.array(Text(200)).max(20),
  compass: z.object({ endgame: Text(500), longLines: z.array(Text(200)).max(10) }).strict(),
}).strict()
export type Bible = z.infer<typeof BibleSchema>

// --- canon/power.json ------------------------------------------------------------------------------------------------

export const RealmSchema = z.object({
  id: Id,
  name: Text(20).min(1),
  /** 1 is the lowest realm; orders are unique and consecutive. */
  order: z.number().int().min(1),
  /** Minor stages inside the realm, lowest first, e.g. 初期 / 中期 / 后期 / 大圆满. At least one. */
  stages: z.array(Text(20).min(1)).min(1).max(12),
  abilities: z.array(Text(100)).max(10),
  breakthrough: z.object({ requires: z.array(Text(100)).max(6), risk: Text(200) }).strict(),
}).strict()
export type Realm = z.infer<typeof RealmSchema>

export const PowerSchema = z.object({
  realms: z.array(RealmSchema).min(2).max(30),
  /** A fight may span at most this many major realms, and only with a stated reason. */
  crossRealmMaxGap: z.number().int().min(0).max(5),
}).strict()
export type Power = z.infer<typeof PowerSchema>

// --- canon/characters.json -------------------------------------------------------------------------------------------

export const RealmPosSchema = z.object({ id: Id, stage: z.number().int().min(0) }).strict()
export type RealmPos = z.infer<typeof RealmPosSchema>

export const CharacterStatusSchema = z.enum(['alive', 'dead', 'missing', 'sealed'])
export const CharacterSchema = z.object({
  id: Id,
  name: Text(20).min(1),
  aliases: z.array(Text(20)).max(10),
  role: z.enum(['protagonist', 'ally', 'rival', 'villain', 'minor']),
  faction: Text(40).optional(),
  /** Absent for mortals and beasts outside the cultivation ladder. */
  realm: RealmPosSchema.optional(),
  status: CharacterStatusSchema,
  location: Text(40).optional(),
  /** Immutable character anchors, e.g. 杀伐果断、不圣母. */
  anchors: z.array(Text(60)).max(8),
  speech: Text(100).optional(),
  relations: z.array(z.object({ to: Id, kind: Text(20), since: Chapter }).strict()).max(40),
  /** Secret ids this character knows. */
  knows: z.array(Id).max(100),
  firstCh: Chapter,
  lastSeenCh: Chapter,
}).strict()
export type Character = z.infer<typeof CharacterSchema>
export const CharactersSchema = z.array(CharacterSchema).max(2000)

// --- canon/items.json ------------------------------------------------------------------------------------------------

export const ITEM_KINDS = ['法宝', '丹药', '灵石', '功法', '材料', '其他'] as const
export const ItemSchema = z.object({
  id: Id,
  name: Text(30).min(1),
  kind: z.enum(ITEM_KINDS),
  grade: Text(20).optional(),
  /** Character id, or `none` for an item nobody holds. */
  owner: Id,
  qty: z.number().int().min(0),
  state: z.enum(['intact', 'damaged', 'consumed', 'destroyed', 'lost']),
  gotCh: Chapter,
}).strict()
export type Item = z.infer<typeof ItemSchema>
export const ItemsSchema = z.array(ItemSchema).max(5000)

// --- canon/world.json ------------------------------------------------------------------------------------------------

export const WorldSchema = z.object({
  factions: z.array(z.object({ id: Id, name: Text(30).min(1), kind: Text(20), strength: Text(100) }).strict()).max(200),
  locations: z.array(z.object({ id: Id, name: Text(30).min(1), region: Text(30), note: Text(200) }).strict()).max(500),
  /** Travel time between two locations by the protagonist's current means, in whole days. Symmetric. */
  routes: z.array(z.object({ from: Id, to: Id, days: z.number().int().min(0) }).strict()).max(2000),
}).strict()
export type World = z.infer<typeof WorldSchema>

// --- canon/foreshadow.json -------------------------------------------------------------------------------------------

export const ForeshadowStatusSchema = z.enum(['open', 'progressing', 'deferred', 'resolved', 'dropped'])
export const ForeshadowSchema = z.object({
  id: Id,
  /** `promise` is a payoff promised to the reader, such as a three-year duel. */
  kind: z.enum(['foreshadow', 'promise']),
  content: Text(300).min(1),
  plantedCh: Chapter,
  dueBy: Chapter.optional(),
  priority: z.enum(['high', 'mid', 'low']),
  status: ForeshadowStatusSchema,
  lastAdvancedCh: Chapter,
  resolvedCh: Chapter.optional(),
}).strict()
export type Foreshadow = z.infer<typeof ForeshadowSchema>
export const ForeshadowsSchema = z.array(ForeshadowSchema).max(5000)

// --- canon/secrets.json ----------------------------------------------------------------------------------------------

export const SecretSchema = z.object({
  id: Id,
  truth: Text(300).min(1),
  revealedToReaderCh: Chapter.optional(),
  knownBy: z.array(Id).max(200),
}).strict()
export type Secret = z.infer<typeof SecretSchema>
export const SecretsSchema = z.array(SecretSchema).max(2000)

// --- canon/timeline.json ---------------------------------------------------------------------------------------------

export const TimelineEntrySchema = z.object({
  ch: z.number().int().min(1),
  dayFrom: z.number().int().min(0),
  dayTo: z.number().int().min(0),
  location: Text(40),
  flashback: z.boolean().optional(),
}).strict()
export type TimelineEntry = z.infer<typeof TimelineEntrySchema>
export const TimelineSchema = z.array(TimelineEntrySchema)

// --- canon/plan.json -------------------------------------------------------------------------------------------------

export const ArcStatusSchema = z.enum(['skeleton', 'planned', 'writing', 'done'])
export const ArcSchema = z.object({
  /** Arc number, global across the book, starting at 1. */
  n: z.number().int().min(1),
  volume: z.number().int().min(1),
  title: Text(40).min(1),
  template: ArcTemplateSchema,
  goal: Text(500),
  /** Estimated chapter count while a skeleton; exact once planned. */
  chapters: z.number().int().min(1).max(200),
  /** First chapter number, set when the arc is planned. */
  startCh: Chapter.optional(),
  /** One line per chapter, set when the arc is planned (`chapters` lines). */
  outline: z.array(Text(200)).max(200).optional(),
  status: ArcStatusSchema,
  summary: Text(1500).optional(),
}).strict()
export type Arc = z.infer<typeof ArcSchema>

export const VolumeSchema = z.object({
  n: z.number().int().min(1),
  title: Text(40).min(1),
  goal: Text(500),
  summary: Text(2000).optional(),
}).strict()
export type Volume = z.infer<typeof VolumeSchema>

export const PlanSchema = z.object({
  volumes: z.array(VolumeSchema).min(1).max(50),
  arcs: z.array(ArcSchema).min(1).max(500),
}).strict()
export type Plan = z.infer<typeof PlanSchema>

// --- canon/pacing.json -----------------------------------------------------------------------------------------------

export const PacingEntrySchema = z.object({
  ch: z.number().int().min(1),
  arc: z.number().int().min(1),
  coolPoint: CoolPointSchema,
  hook: HookSchema,
}).strict()
export type PacingEntry = z.infer<typeof PacingEntrySchema>
export const PacingSchema = z.array(PacingEntrySchema)

// --- Whole canon -----------------------------------------------------------------------------------------------------

export const CANON_FILES = ['bible', 'power', 'characters', 'items', 'world', 'foreshadow', 'secrets', 'timeline', 'plan', 'pacing'] as const
export type CanonFile = typeof CANON_FILES[number]

export const CANON_SCHEMAS = {
  bible: BibleSchema,
  power: PowerSchema,
  characters: CharactersSchema,
  items: ItemsSchema,
  world: WorldSchema,
  foreshadow: ForeshadowsSchema,
  secrets: SecretsSchema,
  timeline: TimelineSchema,
  plan: PlanSchema,
  pacing: PacingSchema,
} as const satisfies Record<CanonFile, z.ZodType>

export interface Canon {
  bible: Bible
  power: Power
  characters: Character[]
  items: Item[]
  world: World
  foreshadow: Foreshadow[]
  secrets: Secret[]
  timeline: TimelineEntry[]
  plan: Plan
  pacing: PacingEntry[]
}

/** The setup document a human (or the setup planner) provides to open a book: everything except the running ledgers. */
export const SetupSchema = z.object({
  bible: BibleSchema,
  power: PowerSchema,
  characters: CharactersSchema,
  items: ItemsSchema.default([]),
  world: WorldSchema,
  foreshadow: ForeshadowsSchema.default([]),
  secrets: SecretsSchema.default([]),
  plan: PlanSchema,
}).strict()
export type Setup = z.infer<typeof SetupSchema>

// --- Chapter contract (sealed before drafting) -----------------------------------------------------------------------

export const ContractSchema = z.object({
  n: z.number().int().min(1),
  title: Text(30).min(1),
  pov: Id,
  goal: Text(300).min(1),
  beats: z.array(Text(200).min(1)).min(3).max(6),
  appearing: z.array(Id).min(1).max(20),
  location: Text(40).min(1),
  coolPoint: z.object({ type: CoolPointSchema, payoff: Text(200) }).strict(),
  hook: z.object({ type: HookSchema, text: Text(200) }).strict(),
  foreshadow: z.object({
    plant: z.array(Text(200)).max(3).default([]),
    advance: z.array(Id).max(5).default([]),
    resolve: z.array(Id).max(3).default([]),
  }).strict(),
  /** Planned state changes in plain words, e.g. 主角突破筑基中期; a realm change the delta reports must be planned here. */
  plannedChanges: z.array(Text(100)).max(6).default([]),
  /** A dead character may appear only when named here (resurrection, flashback, vision). */
  allowDead: z.array(Id).max(5).default([]),
}).strict()
export type Contract = z.infer<typeof ContractSchema>

// --- Extraction delta (one per chapter, every fact quoted) -----------------------------------------------------------

const Quote = z.string().trim().min(2).max(200)

export const NewCharacterSchema = z.object({
  id: Id,
  name: Text(20).min(1),
  aliases: z.array(Text(20)).max(10).default([]),
  role: z.enum(['ally', 'rival', 'villain', 'minor']),
  faction: Text(40).optional(),
  realm: RealmPosSchema.optional(),
  anchors: z.array(Text(60)).max(8).default([]),
  quote: Quote,
}).strict()

export const CharacterChangeSchema = z.object({
  id: Id,
  realm: RealmPosSchema.optional(),
  /** Set with a realm drop that the text explains (injury, curse, sealed cultivation). */
  realmDropReason: Text(100).optional(),
  status: CharacterStatusSchema.optional(),
  location: Text(40).optional(),
  relationsAdd: z.array(z.object({ to: Id, kind: Text(20) }).strict()).max(10).default([]),
  knowsAdd: z.array(Id).max(10).default([]),
  quote: Quote,
}).strict()

export const ItemOpSchema = z.object({
  op: z.enum(['gain', 'consume', 'destroy', 'transfer', 'damage', 'lose']),
  /** Existing item id; for `gain` of a new item, a fresh id plus `name` and `kind`. */
  id: Id,
  name: Text(30).optional(),
  kind: z.enum(ITEM_KINDS).optional(),
  grade: Text(20).optional(),
  qty: z.number().int().min(1).default(1),
  /** Who holds it after the op (`gain`, `transfer`). */
  owner: Id.optional(),
  quote: Quote,
}).strict()

export const ForeshadowOpSchema = z.object({
  op: z.enum(['plant', 'advance', 'resolve', 'defer']),
  /** Existing foreshadow id; for `plant`, a fresh id plus `content`. */
  id: Id,
  content: Text(300).optional(),
  kind: z.enum(['foreshadow', 'promise']).optional(),
  dueBy: Chapter.optional(),
  priority: z.enum(['high', 'mid', 'low']).optional(),
  quote: Quote,
}).strict()

export const DeltaSchema = z.object({
  /** Character ids that act or speak on the page in this chapter (not merely mentioned). */
  appeared: z.array(Id).max(40),
  newCharacters: z.array(NewCharacterSchema).max(20).default([]),
  characterChanges: z.array(CharacterChangeSchema).max(40).default([]),
  items: z.array(ItemOpSchema).max(40).default([]),
  foreshadow: z.array(ForeshadowOpSchema).max(20).default([]),
  secretsRevealed: z.array(z.object({
    id: Id,
    toReader: z.boolean().default(false),
    to: z.array(Id).max(20).default([]),
    quote: Quote,
  }).strict()).max(10).default([]),
  time: z.object({ dayFrom: z.number().int().min(0), dayTo: z.number().int().min(0), flashback: z.boolean().default(false) }).strict(),
  location: Text(40).min(1),
  summary: Text(400).min(20),
  coolPoint: CoolPointSchema,
  hook: HookSchema,
}).strict()
export type Delta = z.infer<typeof DeltaSchema>

// --- Review result ---------------------------------------------------------------------------------------------------

export const REVIEW_DIMENSIONS = ['合同', '人设', '战力', '信息边界', '爽点', '钩子', '节奏', '对话', '文笔'] as const
export const IssueSchema = z.object({
  dimension: z.enum(REVIEW_DIMENSIONS),
  /** `block`: must be fixed; `fix`: should be fixed; `note`: for the arc report only. */
  severity: z.enum(['block', 'fix', 'note']),
  quote: Quote,
  problem: Text(200).min(1),
  suggestion: Text(200),
}).strict()
export type Issue = z.infer<typeof IssueSchema>
export const ReviewSchema = z.object({
  issues: z.array(IssueSchema).max(20),
  /** 1–10 overall readability for a 男频 web-novel reader. */
  score: z.number().int().min(1).max(10),
}).strict()
export type Review = z.infer<typeof ReviewSchema>

// --- Arc plan (model output when an arc goes from skeleton to planned) -----------------------------------------------

export const ArcPlanSchema = z.object({
  title: Text(40).min(1),
  goal: Text(500),
  outline: z.array(Text(200).min(4)).min(5).max(60),
  /** The skeletons of the next one or two arcs, so the book always knows where it goes after this one. */
  next: z.array(z.object({ title: Text(40).min(1), template: ArcTemplateSchema, goal: Text(500), chapters: z.number().int().min(5).max(60) }).strict()).max(2).default([]),
}).strict()
export type ArcPlan = z.infer<typeof ArcPlanSchema>

// --- Arc reconciliation (model output at the end of an arc) ----------------------------------------------------------

export const ArcCloseSchema = z.object({
  summary: Text(1500).min(50),
  /** Foreshadow ids the arc forgot to advance that should be deferred with a new due chapter. */
  defer: z.array(z.object({ id: Id, dueBy: Chapter }).strict()).max(20).default([]),
  /** Characters who appeared but whose canon card is stale; code only applies location and status here. */
  fixes: z.array(z.object({ id: Id, status: CharacterStatusSchema.optional(), location: Text(40).optional() }).strict()).max(40).default([]),
  notes: z.array(Text(200)).max(10).default([]),
}).strict()
export type ArcClose = z.infer<typeof ArcCloseSchema>

// --- Triage (a person's message on a novel ticket) -------------------------------------------------------------------

export const TriageSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('steer'), note: Text(500).min(1), chapters: z.number().int().min(1).max(50).default(5) }).strict(),
  z.object({ kind: z.literal('rewrite'), from: z.number().int().min(1), note: Text(500) }).strict(),
  z.object({ kind: z.literal('pause') }).strict(),
  z.object({ kind: z.literal('resume') }).strict(),
  z.object({ kind: z.literal('answer'), note: Text(500) }).strict(),
  z.object({ kind: z.literal('unclear'), question: Text(200).min(1) }).strict(),
])
export type Triage = z.infer<typeof TriageSchema>

/** Extract the first JSON object from model text (bare, or inside a ```json fence). Undefined when there is none. */
export function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text)
  const candidates = fenced?.[1] ? [fenced[1], text] : [text]
  for (const candidate of candidates) {
    const start = candidate.indexOf('{')
    const end = candidate.lastIndexOf('}')
    if (start < 0 || end <= start) continue
    try {
      return JSON.parse(candidate.slice(start, end + 1))
    } catch { /* try the next candidate */ }
  }
  return undefined
}
