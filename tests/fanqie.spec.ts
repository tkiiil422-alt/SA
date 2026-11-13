import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { FanqieService } from '../src/fanqie/service.ts'
import { FanqieAuthError, mergeCookies } from '../src/fanqie/client.ts'

const chapters = [1, 2, 3].map(n => ({ n, title: `T${n}`, status: n === 3 ? 'flagged' : 'committed', sha256: `h${n}` }))
function make(over: Record<string, unknown> = {}) {
  const calls: string[] = []
  let cookie = 'a=1'
  const svc = new FanqieService({
    db: new DatabaseSync(':memory:'),
    vault: { has: () => true, reveal: () => cookie, update: (_n, p) => { cookie = p.value ?? cookie } },
    novels: { detail: () => ({ chapters }), chapter: n => ({ text: `p1-${n}\n\np2` }) },
    delayMs: 1,
    makeClient: () => ({
      account: async () => ({ name: 'me' }), books: async () => [], volumes: async () => [{ id: 'v', name: 'vol' }],
      newItem: async () => ({ itemId: `i${calls.length}`, volumeId: 'v', volumeName: 'vol' }),
      saveDraft: async (i: { title: string }) => { calls.push('draft:' + i.title) }, publish: async (i: { title: string }) => { calls.push('pub:' + i.title) },
      ...over,
    }) as never,
  })
  return { svc, calls }
}
const wait = async (f: () => boolean) => { for (let i = 0; i < 200 && !f(); i++) await new Promise(r => setTimeout(r, 5)) }

describe('fanqie', () => {
  it('saves drafts for chosen chapters, tracks state, and flags changed text', async () => {
    const { svc, calls } = make()
    svc.bind('b_1', '7706823785470512190')
    svc.start({ bookId: 'b_1', chapters: [2, 1], mode: 'draft', useAi: true })
    await wait(() => !svc.status().job?.running)
    expect(calls).toEqual(['draft:第1章 T1', 'draft:第2章 T2'])
    expect(svc.list('b_1').map(c => c.state)).toEqual(['draft', 'draft', 'none'])
    expect(svc.list('b_1')[2]!.flagged).toBe(true)
  })
  it('refuses unbound books, empty selections and too-early timers', () => {
    const { svc } = make()
    expect(() => svc.start({ bookId: 'b_1', chapters: [1], mode: 'draft', useAi: true })).toThrow('绑定')
    svc.bind('b_1', '7706823785470512190')
    expect(() => svc.start({ bookId: 'b_1', chapters: [], mode: 'draft', useAi: true })).toThrow('一章')
    expect(() => svc.start({ bookId: 'b_1', chapters: [1], mode: 'timer', timerTime: 1, useAi: true })).toThrow('30 分钟')
  })
  it('stops and flags the cookie as expired on an auth failure', async () => {
    const { svc } = make({ saveDraft: async () => { throw new FanqieAuthError('x') } })
    svc.bind('b_1', '7706823785470512190')
    svc.start({ bookId: 'b_1', chapters: [1, 2], mode: 'draft', useAi: true })
    await wait(() => !svc.status().job?.running)
    expect(svc.status().expired).toBe(true)
    expect(svc.status().job?.done).toBe(0)
  })
  it('does not publish a chapter twice', async () => {
    const { svc, calls } = make()
    svc.bind('b_1', '7706823785470512190')
    svc.start({ bookId: 'b_1', chapters: [1], mode: 'publish', useAi: true })
    await wait(() => !svc.status().job?.running)
    svc.start({ bookId: 'b_1', chapters: [1], mode: 'publish', useAi: true })
    await wait(() => !svc.status().job?.running)
    expect(calls).toEqual(['pub:第1章 T1'])
    expect(svc.status().job?.failed).toBe(1)
  })
  it('merges rotated cookies', () => {
    expect(mergeCookies('a=1; b=2', ['b=3; Path=/', 'c=4; Path=/', 'a=; Max-Age=0'])).toBe('b=3; c=4')
  })
})
