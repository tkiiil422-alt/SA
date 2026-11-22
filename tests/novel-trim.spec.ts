/**
 * `trimTooLong`: a model reply whose strings run past a schema's maximum is cut down to fit instead of costing a retry,
 * and a reply with other problems is left for the retry path.
 */
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { outlineRule, trimTooLong } from '../src/novel/pipeline.ts'
import { DeltaSchema } from '../src/novel/schemas.ts'

const base = {
  appeared: ['a'], time: { dayFrom: 0, dayTo: 1 }, location: '青云宗', coolPoint: '突破', hook: '悬念',
}

describe('trimTooLong', () => {
  it('cuts over-long strings, nested ones included, so the delta parses', () => {
    const value = {
      ...base,
      summary: '长'.repeat(450),
      items: [{ op: 'gain', id: 'x', name: '灵石', kind: '灵石', owner: 'a', quote: '字'.repeat(250) }],
    }
    const first = DeltaSchema.safeParse(value)
    expect(first.success).toBe(false)
    const trimmed = trimTooLong(value, first.success ? (undefined as never) : first.error)
    expect(trimmed).toBeDefined()
    const second = DeltaSchema.safeParse(trimmed)
    expect(second.success).toBe(true)
    if (second.success) {
      expect(Array.from(second.data.summary)).toHaveLength(400)
      expect(Array.from(second.data.items[0]!.quote)).toHaveLength(200)
    }
    // The input is not mutated.
    expect(Array.from(value.summary)).toHaveLength(450)
  })

  it('cuts an over-long list down to its maximum', () => {
    const schema = z.object({ resolve: z.array(z.string()).max(3) })
    const value = { resolve: ['a', 'b', 'c', 'd'] }
    const first = schema.safeParse(value)
    expect(first.success).toBe(false)
    const trimmed = trimTooLong(value, first.success ? (undefined as never) : first.error)
    expect(trimmed).toEqual({ resolve: ['a', 'b', 'c'] })
  })

  it('turns the arc outline line for a chapter into a hard planner rule', () => {
    const arc = { n: 1, volume: 1, title: '弧', template: '成长突破' as const, goal: '', chapters: 2, startCh: 10, outline: ['甲事', '乙事破金丹'], status: 'planned' as const }
    expect(outlineRule(arc, 11)[0]).toContain('乙事破金丹')
    expect(outlineRule(arc, 13)).toEqual([])
  })

  it('returns undefined when no issue is a too-long string', () => {
    const value = { ...base, summary: '短' }
    const result = DeltaSchema.safeParse(value)
    expect(result.success).toBe(false)
    expect(trimTooLong(value, result.success ? (undefined as never) : result.error)).toBeUndefined()
  })
})
