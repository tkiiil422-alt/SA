/**
 * NovelStore: ticket bindings, chapter rows, step records, the trigram/LIKE paragraph search and cascading deletes.
 * Each test runs on a fresh `:memory:` database.
 */
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import type { ChapterRow } from '../src/novel/store.ts'
import { NovelStore } from '../src/novel/store.ts'

const opened: DatabaseSync[] = []

afterEach(() => {
  for (const db of opened.splice(0)) db.close()
})

function open(): NovelStore {
  const db = new DatabaseSync(':memory:')
  opened.push(db)
  return new NovelStore(db)
}

const AT = '2026-11-07T00:00:00Z'

function chapter(n: number, overrides: Partial<ChapterRow> = {}): ChapterRow {
  return {
    bookId: 'b_one',
    n,
    arc: 1,
    title: `第${n}章`,
    chars: 2500,
    sha256: `sha-${n}`,
    status: 'committed',
    costUsd: 0.01,
    score: 8,
    committedAt: AT,
    ...overrides,
  }
}

describe('ticket bindings', () => {
  it('binds a pending trigger, attaches its ticket, and finds it both ways', () => {
    const store = open()
    store.bindPending('t1', 'b_one', 1, AT)
    expect(store.byTrigger('t1')).toEqual({ triggerId: 't1', bookId: 'b_one', arc: 1, createdAt: AT })
    expect(store.byTicket('K-1')).toBeUndefined()

    store.bindTicket('t1', 'K-1')
    expect(store.byTicket('K-1')?.triggerId).toBe('t1')
    expect(store.byTrigger('t1')?.ticketId).toBe('K-1')
  })

  it('throws when attaching a ticket to a trigger that was never bound', () => {
    const store = open()
    expect(() => store.bindTicket('missing', 'K-9')).toThrow(/未找到/)
  })

  it('clears only pending bindings, never one that already has a ticket', () => {
    const store = open()
    store.bindPending('t2', 'b_one', 1, AT)
    store.clearPending('t2')
    expect(store.byTrigger('t2')).toBeUndefined()

    store.bindPending('t3', 'b_one', 1, AT)
    store.bindTicket('t3', 'K-3')
    store.clearPending('t3')
    expect(store.byTrigger('t3')?.ticketId).toBe('K-3')
  })

  it('lists a book’s bindings newest first and unbinds a ticket', () => {
    const store = open()
    store.bindPending('t1', 'b_one', 1, AT)
    store.bindPending('t2', 'b_one', 1, AT)
    store.bindPending('t4', 'b_other', 1, AT)
    expect(store.bindings('b_one').map(b => b.triggerId)).toEqual(['t2', 't1'])

    store.bindTicket('t2', 'K-2')
    store.unbindTicket('K-2')
    expect(store.byTicket('K-2')).toBeUndefined()
    expect(store.byTrigger('t2')?.ticketId).toBeUndefined()
  })
})

describe('chapters and steps', () => {
  it('upserts a chapter row and returns chapters in number order', () => {
    const store = open()
    store.recordChapter(chapter(2))
    store.recordChapter(chapter(1))
    store.recordChapter(chapter(1, { chars: 2100, status: 'flagged', score: null }))
    const rows = store.chapters('b_one')
    expect(rows.map(r => r.n)).toEqual([1, 2])
    expect(rows[0]).toEqual(chapter(1, { chars: 2100, status: 'flagged', score: null }))
  })

  it('upserts step records and returns the latest attempt', () => {
    const store = open()
    store.markStep('b_one', 1, 'draft', 1, 'failed', 'boom', AT)
    store.markStep('b_one', 1, 'draft', 2, 'done', '', AT)
    const steps = store.steps('b_one', 1)
    expect(steps).toHaveLength(1)
    expect(steps[0]).toEqual({ step: 'draft', attempt: 2, status: 'done', note: '', at: AT })
    store.clearSteps('b_one', 1)
    expect(store.steps('b_one', 1)).toEqual([])
  })

  it('deleteChaptersFrom removes chapters, steps and indexed paragraphs from n onward', () => {
    const store = open()
    store.indexChapter('b_one', 1, '林默在第一章出现。')
    for (const n of [1, 2, 3]) {
      store.recordChapter(chapter(n))
      store.markStep('b_one', n, 'draft', 1, 'done', '', AT)
    }
    store.indexChapter('b_one', 2, '林默在第二章出现。')
    store.indexChapter('b_one', 3, '林默在第三章出现。')

    store.deleteChaptersFrom('b_one', 2)

    expect(store.chapters('b_one').map(r => r.n)).toEqual([1])
    expect(store.steps('b_one', 1)).toHaveLength(1)
    expect(store.steps('b_one', 2)).toEqual([])
    expect(store.steps('b_one', 3)).toEqual([])
    expect(store.search('b_one', ['林默'], 100, 10).map(r => r.n)).toEqual([1])
  })
})

describe('paragraph search', () => {
  it('finds a three-character Chinese term through the trigram index', () => {
    const store = open()
    store.indexChapter('b_one', 1, '第一段无关。\n\n青云城的少年林默踏入宗门。\n\n林默握紧玉简。')
    expect(store.search('b_one', ['青云城'], 10, 5)).toEqual([{ n: 1, para: '青云城的少年林默踏入宗门。' }])
  })

  it('finds a two-character name through LIKE', () => {
    const store = open()
    store.indexChapter('b_one', 1, '青云城的少年林默踏入宗门。\n\n林默握紧玉简。\n\n无人提起的路人。')
    const hits = store.search('b_one', ['林默'], 10, 5)
    expect(hits.map(h => h.para)).toEqual(['青云城的少年林默踏入宗门。', '林默握紧玉简。'])
    expect(store.search('b_one', ['不存在'], 10, 5)).toEqual([])
  })

  it('only returns chapters before beforeCh', () => {
    const store = open()
    store.indexChapter('b_one', 1, '林默第一次出现。')
    store.indexChapter('b_one', 5, '林默在第五章再度出现。')
    expect(store.search('b_one', ['林默'], 3, 10).map(h => h.n)).toEqual([1])
    expect(store.search('b_one', ['林默'], 10, 10).map(h => h.n)).toEqual([5, 1])
  })

  it('ranks by distinct matched terms, then newest chapter, and honours the limit', () => {
    const store = open()
    store.indexChapter('b_one', 1, '青云城的少年林默踏入宗门。\n\n林默握紧玉简。')
    store.indexChapter('b_one', 2, '林默独自回家。')
    const hits = store.search('b_one', ['青云城', '林默'], 10, 10)
    expect(hits.map(h => [h.n, h.para])).toEqual([
      [1, '青云城的少年林默踏入宗门。'],
      [2, '林默独自回家。'],
      [1, '林默握紧玉简。'],
    ])
    expect(store.search('b_one', ['林默'], 10, 1)).toHaveLength(1)
  })

  it('replaces the paragraphs of a re-indexed chapter', () => {
    const store = open()
    store.indexChapter('b_one', 1, '旧的段落里有林默。')
    store.indexChapter('b_one', 1, '新的段落。')
    expect(store.search('b_one', ['林默'], 10, 5)).toEqual([])
    expect(store.search('b_one', ['新的段落'], 10, 5)).toEqual([{ n: 1, para: '新的段落。' }])
  })

  it('treats LIKE wildcards in short terms as literal characters', () => {
    const store = open()
    store.indexChapter('b_one', 1, '血量100%。\n\n普通的一段。')
    expect(store.search('b_one', ['%'], 10, 5).map(h => h.para)).toEqual(['血量100%。'])
  })
})

describe('book deletion', () => {
  it('removes every row of one book and leaves other books alone', () => {
    const store = open()
    store.bindPending('t1', 'b_one', 1, AT)
    store.recordChapter(chapter(1))
    store.markStep('b_one', 1, 'draft', 1, 'done', '', AT)
    store.indexChapter('b_one', 1, '林默出现。')
    store.bindPending('t9', 'b_two', 1, AT)
    store.recordChapter(chapter(1, { bookId: 'b_two' }))

    store.deleteBook('b_one')

    expect(store.bindings('b_one')).toEqual([])
    expect(store.chapters('b_one')).toEqual([])
    expect(store.steps('b_one', 1)).toEqual([])
    expect(store.search('b_one', ['林默'], 10, 5)).toEqual([])
    expect(store.bindings('b_two')).toHaveLength(1)
    expect(store.chapters('b_two')).toHaveLength(1)
  })
})
