/**
 * Plain-text lint for one drafted chapter. Pure: no disk, no model.
 *
 * Counts are Chinese-aware (`Array.from`) and ignore whitespace and a first-line `# 标题`.
 * `previous` is the list of earlier chapter texts, oldest first; the last five count as recent for opening and ending checks.
 */

export interface LintIssue {
  code: 'chars' | 'aiPhrase' | 'repeat' | 'sameOpening' | 'longParagraph' | 'meta' | 'banned'
  severity: 'fix' | 'note'
  message: string
}

export interface LintOptions {
  chars: [number, number]
  phrases?: string[]
  banned?: string[]
  previous?: string[]
  aiPer1kMax?: number
  paragraphMax?: number
  repeatMin?: number
}

export interface LintResult {
  issues: LintIssue[]
  chars: number
  aiPer1k: number
  phraseHits: Record<string, number>
}

export const DEFAULT_AI_PHRASES: string[] = [
  '仿佛', '缓缓', '微微', '不禁', '一丝', '眼中闪过', '嘴角勾起', '嘴角微微上扬', '深吸一口气', '倒吸一口凉气',
  '心中一凛', '不由得', '淡淡', '莫名', '一抹', '宛如', '似乎', '竟然', '心头一震', '瞳孔一缩', '瞳孔猛地一缩',
  '无法言喻', '难以言喻', '某种', '空气仿佛凝固', '时间仿佛静止',
]

const SENTENCE_END = /[。！？]/
const OPENING_CHARS = 10
const RECENT_CHAPTERS = 5
const META_MARKERS: [string, RegExp][] = [
  ['作为AI', /作为(一个)?AI/],
  ['本章', /本章/],
  ['第N章', /第\d+章/],
  ['字数', /字数/],
  ['以下是', /以下是/],
  ['（完）', /（完）/],
  ['英文单词串', /[A-Za-z]+(?:[ \t]+[A-Za-z]+){2,}/],
  ['Markdown列表', /^[ \t]*(?:[-*+]|\d+\.)[ \t]+/m],
]

const compact = (s: string): string => s.replace(/\s+/g, '')
const charsOf = (s: string): number => Array.from(s).length

/** Drops the first non-empty line when it is a Markdown `# 标题`; returns the rest of the text. */
function splitHeading(text: string): string {
  const lines = text.split('\n')
  const first = lines.findIndex((l) => l.trim() !== '')
  if (first >= 0 && /^#\s+/.test(lines[first]?.trim() ?? '')) lines.splice(first, 1)
  return lines.join('\n')
}

function paragraphsOf(body: string): string[] {
  return body.split(/\n+/).map((p) => p.trim()).filter((p) => p !== '')
}

/** The first sentence of a text, whitespace removed, through its first 。！？ (or the whole text when there is none). */
function firstSentence(text: string): string {
  const flat = compact(text)
  const m = SENTENCE_END.exec(flat)
  return m ? flat.slice(0, m.index + 1) : flat
}

function head(text: string): string {
  return Array.from(text).slice(0, OPENING_CHARS).join('')
}

function openingKey(body: string): string {
  return head(firstSentence(body))
}

function closingKey(body: string): string {
  return head(firstSentence(paragraphsOf(body).at(-1) ?? ''))
}

/** Count of maximal runs of positions where a k-character window of `text` also occurs in an earlier text. */
function sharedRuns(text: string, earlier: string[], k: number): number {
  if (k <= 0 || text.length < k) return 0
  const seen = new Set<string>()
  for (const prev of earlier) {
    for (let j = 0; j + k <= prev.length; j++) seen.add(prev.slice(j, j + k))
  }
  let runs = 0
  let inRun = false
  for (let i = 0; i + k <= text.length; i++) {
    const hit = seen.has(text.slice(i, i + k))
    if (hit && !inRun) runs++
    inRun = hit
  }
  return runs
}

/** Chinese character count of a chapter: whitespace and the first-line heading excluded, code points counted. */
export function countChars(text: string): number {
  return charsOf(compact(splitHeading(text)))
}

export function lintChapter(text: string, opts: LintOptions): LintResult {
  const body = splitHeading(text)
  const flat = compact(body)
  const chars = charsOf(flat)
  const issues: LintIssue[] = []

  const [lo, hi] = opts.chars
  if (chars < lo || chars > hi) {
    issues.push({ code: 'chars', severity: 'fix', message: `字数 ${chars} 不在 ${lo}–${hi} 区间内` })
  }

  const phraseHits: Record<string, number> = {}
  let total = 0
  for (const phrase of opts.phrases ?? DEFAULT_AI_PHRASES) {
    const key = compact(phrase)
    if (key === '') continue
    const count = flat.split(key).length - 1
    if (count > 0) {
      phraseHits[key] = count
      total += count
    }
  }
  const aiPer1k = chars > 0 ? (total * 1000) / chars : 0
  const ranked = Object.entries(phraseHits).sort((a, b) => b[1] - a[1])
  const aiMax = opts.aiPer1kMax ?? 6
  if (aiPer1k > aiMax) {
    const top = ranked.slice(0, 5).map(([p, c]) => `${p}×${c}`).join('、')
    issues.push({
      code: 'aiPhrase',
      severity: 'fix',
      message: `AI 腔短语每千字 ${aiPer1k.toFixed(1)} 次，超过 ${aiMax}：${top}`,
    })
  }
  for (const [phrase, count] of ranked) {
    if (count >= 5) issues.push({ code: 'aiPhrase', severity: 'fix', message: `短语「${phrase}」单章出现 ${count} 次` })
  }

  for (const word of opts.banned ?? []) {
    const key = compact(word)
    if (key !== '' && flat.includes(key)) issues.push({ code: 'banned', severity: 'fix', message: `出现禁用词「${word}」` })
  }

  const previous = (opts.previous ?? []).map((p) => splitHeading(p))
  const repeatMin = opts.repeatMin ?? 12
  const runs = sharedRuns(flat, previous.map(compact), repeatMin)
  if (runs >= 3) {
    issues.push({ code: 'repeat', severity: 'fix', message: `与前文共享 ${runs} 处不少于 ${repeatMin} 字的重复片段` })
  } else if (runs > 0) {
    issues.push({ code: 'repeat', severity: 'note', message: `与前文共享 ${runs} 处不少于 ${repeatMin} 字的重复片段` })
  }

  const recent = previous.slice(-RECENT_CHAPTERS)
  const opening = openingKey(body)
  if (opening !== '' && recent.some((p) => openingKey(p) === opening)) {
    issues.push({ code: 'sameOpening', severity: 'note', message: `本章开头与近章开头相同：「${opening}」` })
  }
  const closing = closingKey(body)
  if (closing !== '' && recent.some((p) => closingKey(p) === closing)) {
    issues.push({ code: 'sameOpening', severity: 'note', message: `本章结尾与近章结尾相同：「${closing}」` })
  }

  const paragraphMax = opts.paragraphMax ?? 300
  const longCount = paragraphsOf(body).filter((p) => charsOf(compact(p)) > paragraphMax).length
  if (longCount > 0) {
    issues.push({ code: 'longParagraph', severity: 'note', message: `有 ${longCount} 段超过 ${paragraphMax} 字` })
  }

  for (const [label, pattern] of META_MARKERS) {
    const m = pattern.exec(body)
    if (m) issues.push({ code: 'meta', severity: 'fix', message: `疑似元话语或格式残留（${label}）：「${m[0].trim()}」` })
  }

  return { issues, chars, aiPer1k, phraseHits }
}
