import { describe, expect, it } from 'vitest'
import { plainTitle } from '../src/infra/text.ts'

describe('plainTitle', () => {
  it('takes the first real line of a Markdown brief, without heading marks', () => {
    expect(plainTitle('# ai-ak47 项目总结文档（只读分析）任务书\n\n## 目标\n\n产出一份 Markdown 项目总结，固定路径 `/`，后台里挤成一团。'))
      .toBe('ai-ak47 项目总结文档（只读分析）任务书')
  })

  it('returns a plain single line unchanged', () => {
    expect(plainTitle('整理 Q1 销售数据')).toBe('整理 Q1 销售数据')
  })

  it('skips blank lines and list markers', () => {
    expect(plainTitle('  \n\n- 第一件事\n第二行')).toBe('第一件事')
  })

  it('removes the leading and trailing bold marks', () => {
    expect(plainTitle('**加粗标题**\n正文')).toBe('加粗标题')
  })

  it('drops backticks but keeps other asterisks', () => {
    expect(plainTitle('用 `rg` 搜 2*3')).toBe('用 rg 搜 2*3')
  })

  it('keeps an asterisk inside a plain line', () => {
    expect(plainTitle('2*3 很重要')).toBe('2*3 很重要')
  })

  it('handles Windows line endings', () => {
    expect(plainTitle('# 标题\r\n\r\n正文')).toBe('标题')
  })

  it('falls back to the trimmed text when every line is only markers', () => {
    expect(plainTitle('###')).toBe('###')
    expect(plainTitle('###\n***')).toBe('###\n***')
  })

  it('truncates by characters and does not split an emoji', () => {
    const result = plainTitle('😀'.repeat(61), 60)
    expect(Array.from(result)).toHaveLength(60)
    expect(result).toBe('😀'.repeat(60))
  })

  it('truncates a long plain line to max characters without an ellipsis', () => {
    expect(plainTitle('a'.repeat(70))).toBe('a'.repeat(60))
    expect(plainTitle('一二三四五', 3)).toBe('一二三')
  })

  it('keeps the first content line of multi-line plain text', () => {
    expect(plainTitle('第一行\n第二行')).toBe('第一行')
  })

  it('returns an empty string for an empty string', () => {
    expect(plainTitle('')).toBe('')
  })

  it('removes ordinal markers', () => {
    expect(plainTitle('1. 第一步\n2. 第二步')).toBe('第一步')
    expect(plainTitle('1、中文序号')).toBe('中文序号')
    expect(plainTitle('2) 括号序号')).toBe('括号序号')
  })

  it('removes a quote marker and a closing heading run', () => {
    expect(plainTitle('> 引用文字')).toBe('引用文字')
    expect(plainTitle('## 标题 ##')).toBe('标题')
  })

  it('collapses whitespace runs into one space', () => {
    expect(plainTitle('整理   Q1\t销售  数据')).toBe('整理 Q1 销售 数据')
  })
})
