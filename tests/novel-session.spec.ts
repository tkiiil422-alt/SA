import { describe, expect, it } from 'vitest'
import { callModel } from '../src/assessor/model-call.ts'
import { RoleSessionPool } from '../src/novel/session.ts'
import { htmlToPlainText, resolveEmailEndpoints } from '../src/sources/email.ts'
import { defaultOptions } from '../src/admin/options.ts'

describe('RoleSessionPool (multi-chapter cache reuse)', () => {
  it('keeps system and prior messages byte-identical across consecutive chapters and never ends with assistant prefill', async () => {
    const pool = new RoleSessionPool({ maxTurns: 5, maxChars: 100_000 })
    const sentPayloads: Array<{ messages: Array<{ role: string; content: string }>; session?: string }> = []
    const fakeFetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { messages: Array<{ role: string; content: string }> }
      const headers = (init?.headers ?? {}) as Record<string, string>
      sentPayloads.push({ messages: body.messages, session: headers['x-session-id'] })
      const ch = sentPayloads.length
      return new Response(JSON.stringify({
        choices: [{ message: { content: `第${ch}章正文内容……` }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5000, completion_tokens: 9000 },
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch

    const target = {
      api: 'openai-completions' as const,
      baseUrl: 'https://gw.example',
      apiKey: 'k',
      sessionHeader: 'x-session-id',
    }

    for (let ch = 1; ch <= 3; ch += 1) {
      const user = `请写第 ${ch} 章，动态推进信息 ${ch}`
      // Even if caller passes a slightly updated stableContext on later turns, the session keeps turn-1's frozen system!
      const p = pool.prepare({
        bookId: 'b_1',
        role: 'writer',
        modelKey: 'gw/gemini-4-hydrogen',
        baseSystem: 'WRITER_BASE_RULES',
        stableContext: `WORLD_BIBLE_V${ch}`,
        nextUserChars: user.length,
      })
      const res = await callModel(target, {
        model: 'gemini-4-hydrogen',
        system: p.system,
        user,
        maxTokens: 16000,
        ...(p.history.length > 0 ? { history: p.history } : {}),
      }, { timeoutMs: 5000, fetch: fakeFetch, sessionId: p.sessionId })
      expect(res.ok).toBe(true)
      p.commit(user, res.text)
    }

    expect(sentPayloads).toHaveLength(3)
    // All 3 turns share the exact same sessionId and byte-identical system prompt (from turn 1)
    expect(sentPayloads[0]!.session).toBe(sentPayloads[1]!.session)
    expect(sentPayloads[1]!.session).toBe(sentPayloads[2]!.session)
    expect(sentPayloads[0]!.messages[0]).toEqual(sentPayloads[2]!.messages[0])
    expect(sentPayloads[2]!.messages[0]!.content).toBe('WRITER_BASE_RULES\n\nWORLD_BIBLE_V1')

    // Turn 3 carries exact byte-identical turns 1 & 2, and ends with role === 'user' (never assistant prefill)
    const m3 = sentPayloads[2]!.messages
    expect(m3.map(m => m.role)).toEqual(['system', 'user', 'assistant', 'user', 'assistant', 'user'])
    expect(m3[1]).toEqual(sentPayloads[0]!.messages[1])
    expect(m3[2]!.content).toBe('第1章正文内容……')
    expect(m3[3]).toEqual(sentPayloads[1]!.messages[3])
    expect(m3[4]!.content).toBe('第2章正文内容……')
    expect(m3.at(-1)!.role).toBe('user')
  })

  it('never mixes models in one session and rolls over cleanly after maxTurns or resetBook', () => {
    const pool = new RoleSessionPool({ maxTurns: 2, maxChars: 100_000 })

    // Turn 1 on gemini-4-hydrogen
    const p1 = pool.prepare({ bookId: 'b_2', role: 'writer', modelKey: 'gw/gemini-4-hydrogen', baseSystem: 'SYS', stableContext: 'BIBLE', nextUserChars: 10 })
    p1.commit('u1', 'a1')

    // Separate role (reviewer on gemini-4-neon) gets its own independent session
    const rev = pool.prepare({ bookId: 'b_2', role: 'reviewer', modelKey: 'gw/gemini-4-neon', baseSystem: 'REV', nextUserChars: 10 })
    expect(rev.sessionId).not.toBe(p1.sessionId)
    expect(rev.history).toHaveLength(0)

    // Turn 2 on same model reuses session
    const p2 = pool.prepare({ bookId: 'b_2', role: 'writer', modelKey: 'gw/gemini-4-hydrogen', baseSystem: 'SYS', stableContext: 'BIBLE', nextUserChars: 10 })
    expect(p2.sessionId).toBe(p1.sessionId)
    expect(p2.history).toHaveLength(2)
    p2.commit('u2', 'a2')

    // Turn 3 hits maxTurns=2 -> rolls over to fresh session s2
    const p3 = pool.prepare({ bookId: 'b_2', role: 'writer', modelKey: 'gw/gemini-4-hydrogen', baseSystem: 'SYS', stableContext: 'BIBLE_NEW', nextUserChars: 10 })
    expect(p3.sessionId).not.toBe(p1.sessionId)
    expect(p3.history).toHaveLength(0)
    expect(p3.system).toContain('BIBLE_NEW')
    p3.commit('u3', 'a3')

    // Changing model rotates session immediately (never mixes models)
    const p4 = pool.prepare({ bookId: 'b_2', role: 'writer', modelKey: 'gw/gemini-4-neon', baseSystem: 'SYS', stableContext: 'BIBLE_NEW', nextUserChars: 10 })
    expect(p4.sessionId).not.toBe(p3.sessionId)
    expect(p4.history).toHaveLength(0)
    p4.commit('u4', 'a4')

    // resetBook clears all sessions for that book
    pool.resetBook('b_2')
    const p5 = pool.prepare({ bookId: 'b_2', role: 'writer', modelKey: 'gw/gemini-4-neon', baseSystem: 'SYS', stableContext: 'BIBLE_NEW', nextUserChars: 10 })
    expect(p5.history).toHaveLength(0)
  })
})

describe('Universal email presets & HTML fallback', () => {
  it('resolves QQ, 163, Outlook, and custom IMAP/SMTP presets accurately', () => {
    const base = { ...defaultOptions({}).email, password: 'pw' }
    expect(resolveEmailEndpoints({ ...base, preset: 'qq' })).toMatchObject({
      imapHost: 'imap.qq.com', imapPort: 993, imapSecure: true, smtpHost: 'smtp.qq.com', smtpPort: 465, smtpSecure: true,
    })
    expect(resolveEmailEndpoints({ ...base, preset: '163' })).toMatchObject({
      imapHost: 'imap.163.com', smtpHost: 'smtp.163.com',
    })
    expect(resolveEmailEndpoints({ ...base, preset: 'outlook' })).toMatchObject({
      imapHost: 'outlook.office365.com', smtpHost: 'smtp.office365.com', smtpPort: 587, smtpSecure: false,
    })
    expect(resolveEmailEndpoints({
      ...base, preset: 'custom', imapHost: 'mail.corp.internal', imapPort: 1993, imapSecure: true, smtpHost: 'smtp.corp.internal', smtpPort: 587, smtpSecure: false, folder: 'SuperAgent',
    })).toMatchObject({
      imapHost: 'mail.corp.internal', imapPort: 1993, smtpHost: 'smtp.corp.internal', smtpPort: 587, smtpSecure: false, folder: 'SuperAgent',
    })
  })

  it('extracts clean plain text from HTML-only emails', () => {
    const text = htmlToPlainText('<html><style>body{color:red}</style><body><p>Hello&nbsp;<b>World</b></p><div>Line 2</div></body></html>')
    expect(text).toBe('Hello World\nLine 2')
  })
})
