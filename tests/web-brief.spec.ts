import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'

const moduleUrl = pathToFileURL(join(process.cwd(), 'src/admin/web/lib/brief.js')).href

async function load(): Promise<any> {
  return import(moduleUrl)
}

const BRIEF = `# 给销售看板加上同比

## 目标

让业务同事一眼看出同比变化。

## 范围

- 看板
- 导出

## 待你确认

- 同比按自然月还是按周对齐？默认：按自然月对齐。
- 导出格式用 CSV 还是 XLSX？默认: CSV（UTF-8 BOM）。
1) 历史数据回填到哪一年？默认：回填到 2025-01。

## 会商分歧

无。
`

describe('parseBrief', () => {
  it('reads the title, sections and questions with Chinese and English colons', async () => {
    const { parseBrief } = await load()
    const brief = parseBrief(BRIEF)
    expect(brief.title).toBe('给销售看板加上同比')
    expect(brief.sections.map((section: any) => section.heading)).toEqual([
      '目标', '范围', '待你确认', '会商分歧',
    ])
    expect(brief.questions).toEqual([
      { text: '同比按自然月还是按周对齐？', default: '按自然月对齐。' },
      { text: '导出格式用 CSV 还是 XLSX？', default: 'CSV（UTF-8 BOM）。' },
      { text: '历史数据回填到哪一年？', default: '回填到 2025-01。' },
    ])
  })

  it('tolerates a missing title, reordered sections and other list markers', async () => {
    const { parseBrief } = await load()
    const markdown = `## 待你确认
* 要不要保留旧接口？默认：保留一个版本。
+ 谁来验收？默认：测试同学先验。

## 目标
先做出来。`
    const brief = parseBrief(markdown)
    expect(brief.title).toBe('')
    expect(brief.sections.map((section: any) => section.heading)).toEqual(['待你确认', '目标'])
    expect(brief.questions).toHaveLength(2)
    expect(brief.questions[1]).toEqual({ text: '谁来验收？', default: '测试同学先验。' })
  })

  it('returns empty questions when there is no confirmation section', async () => {
    const { parseBrief } = await load()
    const brief = parseBrief('# 标题\n\n## 目标\n\n做完。\n')
    expect(brief.questions).toEqual([])
    expect(brief.sections).toEqual([{ heading: '目标', body: '做完。' }])
  })

  it('does not mistake a heading inside a fenced block for a section', async () => {
    const { parseBrief } = await load()
    const brief = parseBrief('# 标题\n\n## 步骤\n\n```bash\n## 这不是标题\npnpm test\n```\n')
    expect(brief.sections).toHaveLength(1)
    expect(brief.sections[0].body).toContain('## 这不是标题')
  })

  it('survives empty and malformed input', async () => {
    const { parseBrief } = await load()
    expect(parseBrief('')).toEqual({ title: '', sections: [], questions: [] })
    expect(parseBrief(undefined)).toEqual({ title: '', sections: [], questions: [] })
    expect(parseBrief('只是一段正文').sections).toEqual([])
  })
})

describe('appendConfirmations', () => {
  it('appends a confirmed section with every answer', async () => {
    const { appendConfirmations } = await load()
    const output = appendConfirmations(BRIEF, [
      { text: '同比按自然月还是按周对齐？', answer: '按自然月对齐。' },
      { question: '导出格式用 CSV 还是 XLSX？', value: 'XLSX' },
    ])
    expect(output.endsWith('## 已确认\n\n- 同比按自然月还是按周对齐？：按自然月对齐。\n- 导出格式用 CSV 还是 XLSX？：XLSX\n')).toBe(true)
    expect(output.match(/## 已确认/g)).toHaveLength(1)
  })

  it('accepts an object map and ignores empty answers', async () => {
    const { appendConfirmations } = await load()
    const output = appendConfirmations('# 标题', { '要保留吗？': '保留', '空的？': '   ' })
    expect(output).toBe('# 标题\n\n## 已确认\n\n- 要保留吗？：保留\n')
  })

  it('returns the original text when there is nothing to confirm', async () => {
    const { appendConfirmations } = await load()
    expect(appendConfirmations('# 标题\n', [])).toBe('# 标题')
    expect(appendConfirmations('# 标题\n', undefined)).toBe('# 标题')
  })

  it('replaces an older confirmation section instead of duplicating it', async () => {
    const { appendConfirmations } = await load()
    const first = appendConfirmations('# 标题', [{ text: '问？', answer: '一' }])
    const second = appendConfirmations(first, [{ text: '问？', answer: '二' }])
    expect(second.match(/## 已确认/g)).toHaveLength(1)
    expect(second).toContain('- 问？：二')
    expect(second).not.toContain('- 问？：一\n')
  })
})

describe('splitDecision', () => {
  it('reads the four decision parts in any order and with numbering', async () => {
    const { splitDecision } = await load()
    const text = `## 1. 理由

因为要做。

## 建议

先做 CSV。

## 风险

导出可能很大。

## 备选

XLSX。`
    expect(splitDecision(text)).toEqual({
      advice: '先做 CSV。',
      reason: '因为要做。',
      alternatives: 'XLSX。',
      risks: '导出可能很大。',
    })
  })

  it('fills missing parts with empty strings', async () => {
    const { splitDecision } = await load()
    expect(splitDecision('## 建议\n\n做。')).toEqual({
      advice: '做。', reason: '', alternatives: '', risks: '',
    })
    expect(splitDecision('')).toEqual({ advice: '', reason: '', alternatives: '', risks: '' })
  })

  it('ignores headings inside fenced code blocks', async () => {
    const { splitDecision } = await load()
    const text = `## 建议

\`\`\`md
## 风险
这不是风险段
\`\`\`

## 风险

真实的。`
    const parts = splitDecision(text)
    expect(parts.advice).toContain('## 风险')
    expect(parts.risks).toBe('真实的。')
  })

  it('tolerates headings that are not level two', async () => {
    const { splitDecision } = await load()
    expect(splitDecision('### 建议\n\n做。').advice).toBe('做。')
  })
})
