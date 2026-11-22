import { describe, expect, it } from 'vitest'
import { DEFAULT_AI_PHRASES, countChars, lintChapter } from '../src/novel/lint.ts'
import type { LintIssue, LintOptions } from '../src/novel/lint.ts'

const OPTS: LintOptions = { chars: [500, 2000] }
const WIDE: LintOptions = { chars: [1, 5000] }
const SENTENCE = '青石镇的夜风吹过旧街巷口的老槐树梢'
const FILLER = '远'.repeat(30)

/** Plain prose of exactly `n` characters, split into paragraphs of at most 200 characters. */
function prose(n: number, unit = '远'): string {
  const chunks: string[] = []
  for (let left = n; left > 0; left -= 200) chunks.push(unit.repeat(Math.min(200, left)))
  return chunks.join('\n\n')
}

const byCode = (issues: LintIssue[], code: LintIssue['code']): LintIssue[] => issues.filter((i) => i.code === code)

describe('DEFAULT_AI_PHRASES', () => {
  it('contains the required starter list', () => {
    const required = [
      '仿佛', '缓缓', '微微', '不禁', '一丝', '眼中闪过', '嘴角勾起', '嘴角微微上扬', '深吸一口气', '倒吸一口凉气',
      '心中一凛', '不由得', '淡淡', '莫名', '一抹', '宛如', '似乎', '竟然', '心头一震', '瞳孔一缩', '瞳孔猛地一缩',
      '无法言喻', '难以言喻', '某种', '空气仿佛凝固', '时间仿佛静止',
    ]
    for (const word of required) expect(DEFAULT_AI_PHRASES).toContain(word)
  })
})

describe('countChars', () => {
  it('ignores whitespace and a first-line heading', () => {
    expect(countChars('# 标题\n甲 乙\n丙')).toBe(3)
  })

  it('counts code points, so astral Chinese characters count once', () => {
    expect(countChars('𠀀𠀁')).toBe(2)
  })

  it('returns zero for whitespace only', () => {
    expect(countChars('  \n\t ')).toBe(0)
  })
})

describe('lintChapter', () => {
  it('chars: flags a length outside the range with the actual count and the range', () => {
    const issues = lintChapter('远'.repeat(10), OPTS).issues
    const hit = byCode(issues, 'chars')
    expect(hit).toHaveLength(1)
    expect(hit[0]?.severity).toBe('fix')
    expect(hit[0]?.message).toContain('10')
    expect(hit[0]?.message).toContain('500–2000')
  })

  it('chars: a length inside the range is fine and is reported', () => {
    const result = lintChapter(prose(600), OPTS)
    expect(byCode(result.issues, 'chars')).toEqual([])
    expect(result.chars).toBe(600)
  })

  it('aiPhrase: flags density above the per-thousand maximum and lists the top phrases', () => {
    const result = lintChapter('仿佛'.repeat(7) + prose(986), OPTS)
    const hit = byCode(result.issues, 'aiPhrase')
    expect(hit.some((i) => i.severity === 'fix' && i.message.includes('仿佛×7'))).toBe(true)
    expect(result.phraseHits['仿佛']).toBe(7)
    expect(result.aiPer1k).toBeCloseTo(7, 5)
  })

  it('aiPhrase: density at or below the maximum is fine', () => {
    const result = lintChapter('仿佛'.repeat(2) + prose(996), OPTS)
    expect(byCode(result.issues, 'aiPhrase')).toEqual([])
    expect(result.aiPer1k).toBeCloseTo(2, 5)
  })

  it('aiPhrase: one phrase appearing five times in a chapter is flagged on its own', () => {
    const result = lintChapter('缓缓'.repeat(5) + prose(990), OPTS)
    const hit = byCode(result.issues, 'aiPhrase')
    expect(hit).toHaveLength(1)
    expect(hit[0]?.message).toContain('缓缓')
  })

  it('aiPhrase: four occurrences of one phrase are fine', () => {
    expect(byCode(lintChapter('缓缓'.repeat(4) + prose(992), OPTS).issues, 'aiPhrase')).toEqual([])
  })

  it('banned: flags a banned word that appears', () => {
    const hit = byCode(lintChapter(prose(600) + '\n\n综上所述', { ...OPTS, banned: ['综上所述'] }).issues, 'banned')
    expect(hit).toHaveLength(1)
    expect(hit[0]?.severity).toBe('fix')
  })

  it('banned: a chapter without the word is fine', () => {
    expect(byCode(lintChapter(prose(600), { ...OPTS, banned: ['综上所述'] }).issues, 'banned')).toEqual([])
  })

  it('repeat: three shared runs of at least repeatMin characters are a fix', () => {
    const text = [SENTENCE, FILLER, SENTENCE, FILLER, SENTENCE].join('')
    const hit = byCode(lintChapter(text, { ...WIDE, previous: [SENTENCE] }).issues, 'repeat')
    expect(hit).toHaveLength(1)
    expect(hit[0]?.severity).toBe('fix')
  })

  it('repeat: one or two shared runs are only a note', () => {
    const once = byCode(lintChapter(FILLER + SENTENCE + FILLER, { ...WIDE, previous: [SENTENCE] }).issues, 'repeat')
    expect(once).toHaveLength(1)
    expect(once[0]?.severity).toBe('note')
    const twice = byCode(lintChapter([SENTENCE, FILLER, SENTENCE].join(''), { ...WIDE, previous: [SENTENCE] }).issues, 'repeat')
    expect(twice[0]?.severity).toBe('note')
  })

  it('repeat: no shared run is fine', () => {
    expect(byCode(lintChapter(prose(600), { ...OPTS, previous: [SENTENCE] }).issues, 'repeat')).toEqual([])
  })

  it('sameOpening: a first sentence matching a recent chapter opening is a note', () => {
    const previous = ['青石镇的夜色深沉如墨。林远独自走出门外。']
    const issues = lintChapter('青石镇的夜色深沉如墨。他抬头望天。' + prose(600).slice(0), { ...OPTS, previous }).issues
    const hit = byCode(issues, 'sameOpening')
    expect(hit.some((i) => i.severity === 'note' && i.message.includes('开头'))).toBe(true)
  })

  it('sameOpening: a different opening is fine', () => {
    const previous = ['青石镇的夜色深沉如墨。林远独自走出门外。']
    const issues = lintChapter('林远推开门。' + prose(600), { ...OPTS, previous }).issues
    expect(byCode(issues, 'sameOpening').some((i) => i.message.includes('开头'))).toBe(false)
  })

  it('sameOpening: a matching last paragraph opening is a note', () => {
    const previous = ['第一段内容。\n\n他回头一笑，转身离开。']
    const issues = lintChapter(prose(600) + '\n\n他回头一笑，转身离开。', { ...OPTS, previous }).issues
    const hit = byCode(issues, 'sameOpening')
    expect(hit.some((i) => i.severity === 'note' && i.message.includes('结尾'))).toBe(true)
  })

  it('sameOpening: a different last paragraph is fine', () => {
    const previous = ['第一段内容。\n\n他回头一笑，转身离开。']
    const issues = lintChapter(prose(600) + '\n\n林远叹了口气，继续前行。', { ...OPTS, previous }).issues
    expect(byCode(issues, 'sameOpening').some((i) => i.message.includes('结尾'))).toBe(false)
  })

  it('longParagraph: a paragraph over the limit is a note with the count', () => {
    const hit = byCode(lintChapter('远'.repeat(301), WIDE).issues, 'longParagraph')
    expect(hit).toHaveLength(1)
    expect(hit[0]?.severity).toBe('note')
    expect(hit[0]?.message).toContain('1 段')
  })

  it('longParagraph: a paragraph exactly at the limit is fine', () => {
    expect(byCode(lintChapter('远'.repeat(300), WIDE).issues, 'longParagraph')).toEqual([])
  })

  it.each([
    ['作为AI助手我认为如下', '作为AI'],
    ['本章完结', '本章'],
    ['第3章的伏笔', '第N章'],
    ['字数已经足够', '字数'],
    ['以下是改写后的正文', '以下是'],
    ['（完）', '（完）'],
    ['Once upon a time', '英文单词串'],
    ['- 列表项', 'Markdown列表'],
  ])('meta: flags %s', (line) => {
    const hit = byCode(lintChapter(prose(600) + '\n\n' + line, OPTS).issues, 'meta')
    expect(hit).toHaveLength(1)
    expect(hit[0]?.severity).toBe('fix')
  })

  it('meta: clean prose and a first-line heading with a chapter number are fine', () => {
    expect(byCode(lintChapter('# 第3章 启程\n\n' + prose(600), OPTS).issues, 'meta')).toEqual([])
  })
})
