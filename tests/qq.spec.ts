import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { NovelStore } from '../src/novel/store.ts'
import { NovelService } from '../src/novel/service.ts'
import { BookFiles } from '../src/novel/files.ts'
import {
  buildQqChoicePayload,
  buildQqNovelEditPayload,
  buildQqPendingActionPayload,
  decodeQqAction,
  encodeQqAction,
  extractQqChoiceButtons,
  formatTextForQq,
} from '../src/sources/qq-cards.ts'
import {
  QqSource,
  deriveQqEd25519Keys,
  signQqValidation,
  verifyQqWebhookSignature,
  type QqConfig,
  type QqInboundMessage,
  type QqInteractionEvent,
  type QqWsLike,
} from '../src/sources/qq.ts'
import { sign as edSign, verify as edVerify } from 'node:crypto'

const dirs: string[] = []
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true })
})

function baseQqConfig(patch: Partial<QqConfig> = {}): QqConfig {
  return {
    enabled: true,
    mode: 'ws',
    appId: '102000111',
    appSecret: 'qq_secret_XYZ_9876543210',
    sandbox: false,
    apiBase: 'https://api.sgroup.qq.com',
    groupMode: 'mention',
    allowedUsers: [],
    routingMode: 'director',
    interactiveButtons: true,
    markdownTemplateId: '',
    keyboardTemplateId: '',
    ...patch,
  }
}

describe('QQ formatter, choice extraction and action codec', () => {
  it('cleans headings, bold, links, tables and splits cleanly for QQ', () => {
    const md = [
      '## 平台状态汇总',
      '',
      '**运行中**：共 `2` 个工单',
      '- 查看 [控制台](https://example.com/admin)',
      '| 项目 | 状态 |',
      '| --- | --- |',
      '| gateway | 正常 |',
    ].join('\n')

    const formatted = formatTextForQq(md)
    expect(formatted).toContain('【平台状态汇总】')
    expect(formatted).toContain('运行中：共 2 个工单')
    expect(formatted).toContain('• 查看 控制台（https://example.com/admin）')
    expect(formatted).toContain('• gateway（状态：正常）')
    expect(formatted).not.toContain('**')
    expect(formatted).not.toContain('| --- |')
  })

  it('extracts 2-4 clickable choice buttons from natural language replies and round-trips action codec', () => {
    const replyA = [
      '发现第 3 步失败了，有两个处理方向：',
      '1. 继续重试（保留原参数）',
      '2. 切换备用模型并继续',
      '请选择你希望我怎么处理？',
    ].join('\n')
    const choicesA = extractQqChoiceButtons(replyA)
    expect(choicesA).toHaveLength(2)
    expect(choicesA[0]?.label).toContain('选项1')
    expect(choicesA[1]?.label).toContain('选项2')

    const replyB = '当前等待你拍板：请回复「批准继续」或「先暂停」。'
    const choicesB = extractQqChoiceButtons(replyB)
    expect(choicesB).toEqual([
      { label: '批准继续', text: '批准继续' },
      { label: '先暂停', text: '先暂停' },
    ])

    const payload = buildQqChoicePayload(replyB, choicesB)
    expect(payload.keyboard?.content?.rows[0]?.buttons).toHaveLength(2)

    const longChoice = '继续按方案 A 深度重构第 3 章开篇并自动触发一次连贯性校验和小说改稿通知推送测试'
    const encoded = encodeQqAction({ kind: 'choice', text: longChoice })
    expect(Buffer.byteLength(encoded, 'utf8')).toBeLessThanOrEqual(96)
    expect(decodeQqAction(encoded)).toEqual({ kind: 'choice', text: longChoice })

    const da = encodeQqAction({ kind: 'director_action', actionId: 'act_1', decision: 'approve' })
    expect(decodeQqAction(da)).toEqual({ kind: 'director_action', actionId: 'act_1', decision: 'approve' })

    const nu = encodeQqAction({ kind: 'novel_undo', bookId: 'b_1', n: 5 })
    expect(decodeQqAction(nu)).toEqual({ kind: 'novel_undo', bookId: 'b_1', n: 5 })
  })

  it('builds pending action & novel edit payloads with clickable keyboard buttons', () => {
    const p1 = buildQqPendingActionPayload({
      actionId: 'a_9',
      toolName: 'host_shell',
      summary: '重启控制台容器',
      replyBody: '准备执行变更。',
    })
    expect(p1.text).toContain('#a_9')
    expect(p1.keyboard?.content?.rows[0]?.buttons.map(b => b.action.data)).toEqual([
      'da:a_9:1',
      'da:a_9:0',
    ])

    const p2 = buildQqNovelEditPayload({
      bookId: 'b_9',
      bookTitle: '问道长生',
      n: 12,
      chapterTitle: '初入宗门',
      status: 'done',
      note: '加强打斗描写',
      charsBefore: 2400,
      charsAfter: 2950,
      costUsd: 0.0123,
    })
    expect(p2.text).toContain('改稿完成')
    expect(p2.text).toContain('2400 字 → 2950 字')
    expect(p2.keyboard?.content?.rows[0]?.buttons[0]?.action.data).toBe('nu:b_9:12')
  })
})

describe('QqSource webhook, websocket, rich fallback and credential redaction', () => {
  it('handles HTTP Webhook op=13 Ed25519 validation and verifies signed C2C message events', async () => {
    const cfg = baseQqConfig({ mode: 'webhook' })
    const inbound: QqInboundMessage[] = []
    const qq = new QqSource({
      config: () => cfg,
      onMessage: m => inbound.push(m),
    })

    const server = createServer((req, res) => {
      void qq.handleHttp(req, res)
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    try {
      const addr = server.address() as { port: number }
      const url = `http://127.0.0.1:${addr.port}/qq/events`

      // 1. op=13 回调地址验证
      const vRes = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          op: 13,
          d: { plain_token: 'pt_verify_123', event_ts: '1700000100' },
        }),
      })
      expect(vRes.status).toBe(200)
      const vJson = await vRes.json() as { plain_token: string; signature: string }
      expect(vJson.plain_token).toBe('pt_verify_123')
      const { publicKey } = deriveQqEd25519Keys(cfg.appSecret)
      expect(
        edVerify(
          null,
          Buffer.from('1700000100pt_verify_123', 'utf8'),
          publicKey,
          Buffer.from(vJson.signature, 'hex'),
        ),
      ).toBe(true)

      // 2. 伪造签名应返回 401
      const badRes = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-signature-timestamp': '1700000101',
          'x-signature-ed25519': '00'.repeat(64),
        },
        body: JSON.stringify({ op: 0, t: 'C2C_MESSAGE_CREATE', d: {} }),
      })
      expect(badRes.status).toBe(401)

      // 3. 合法签名事件正确投递到 onMessage
      const bodyStr = JSON.stringify({
        op: 0,
        t: 'C2C_MESSAGE_CREATE',
        d: {
          id: 'msg_wh_1',
          content: '查一下现在有多少上下文',
          timestamp: '2026-11-25T12:00:00Z',
          author: { user_openid: 'qq_user_42' },
        },
      })
      const ts = '1700000102'
      const { privateKey } = deriveQqEd25519Keys(cfg.appSecret)
      const sigHex = edSign(null, Buffer.from(`${ts}${bodyStr}`, 'utf8'), privateKey).toString('hex')
      expect(verifyQqWebhookSignature(cfg.appSecret, ts, bodyStr, sigHex)).toBe(true)

      const okRes = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-signature-timestamp': ts,
          'x-signature-ed25519': sigHex,
        },
        body: bodyStr,
      })
      expect(okRes.status).toBe(200)
      expect(inbound).toHaveLength(1)
      expect(inbound[0]).toMatchObject({
        chatType: 'c2c',
        from: 'qq_user_42',
        messageId: 'msg_wh_1',
        text: '查一下现在有多少上下文',
      })

      // 4. signQqValidation 输出与 verify 一致
      const signed = signQqValidation(cfg.appSecret, '1700000109', 'tok')
      expect(signed.plain_token).toBe('tok')
      expect(signed.signature).toHaveLength(128)
    } finally {
      qq.stop()
      server.close()
    }
  })

  it('connects via WebSocket gateway, handles INTERACTION_CREATE buttons, and falls back to plain text on 304057 without leaking secrets', async () => {
    const cfg = baseQqConfig({ mode: 'ws' })
    const sentHttp: { url: string; method: string; body?: any }[] = []
    const inbound: QqInboundMessage[] = []
    const interactions: QqInteractionEvent[] = []
    const events: string[] = []
    const fakeWsListeners = new Map<string, ((ev: any) => void)[]>()
    const fakeWsSent: string[] = []

    const fakeSocket: QqWsLike = {
      readyState: 1,
      send: data => fakeWsSent.push(data),
      close: () => {},
      addEventListener: (type, listener) => {
        const list = fakeWsListeners.get(type) ?? []
        list.push(listener)
        fakeWsListeners.set(type, list)
      },
    }

    const fakeFetch: typeof fetch = (async (input, init) => {
      const url = String(input)
      const method = (init?.method ?? 'GET').toUpperCase()
      const parsedBody = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
      sentHttp.push({ url, method, body: parsedBody })

      if (url.includes('getAppAccessToken')) {
        return new Response(JSON.stringify({ access_token: 'SECRET_QQ_ACCESS_TOKEN_888', expires_in: 7200 }), { status: 200 })
      }
      if (url.endsWith('/gateway')) {
        return new Response(JSON.stringify({ url: 'wss://api.sgroup.qq.com/websocket' }), { status: 200 })
      }
      if (url.includes('/interactions/')) {
        return new Response(JSON.stringify({}), { status: 200 })
      }
      if (url.includes('/v2/users/') && parsedBody?.msg_type === 2) {
        // 模拟 QQ 开放平台未授权自定义按钮/Markdown：返回 400 + 304057，验证自动纯文本降级且错误日志不泄密
        return new Response(JSON.stringify({ code: 304057, message: `keyboard not allowed secret=${cfg.appSecret}` }), { status: 400 })
      }
      return new Response(JSON.stringify({ id: 'qq_msg_sent_1' }), { status: 200 })
    }) as typeof fetch

    const qq = new QqSource({
      config: () => cfg,
      onMessage: m => inbound.push(m),
      onInteraction: async ev => {
        interactions.push(ev)
        return { code: 0, replyText: '✅ **已执行完毕**' }
      },
      onEvent: ev => events.push(ev.text),
      fetch: fakeFetch,
      wsFactory: () => fakeSocket,
    })

    await qq.start()
    const emitWs = (pkt: unknown) => {
      for (const fn of fakeWsListeners.get('message') ?? []) fn({ data: JSON.stringify(pkt) })
    }
    emitWs({ op: 10, d: { heartbeat_interval: 30000 } })
    expect(JSON.parse(fakeWsSent[0]!).op).toBe(2)

    emitWs({ op: 0, s: 1, t: 'READY', d: { session_id: 'ws_sess_1', user: { id: 'bot_1', username: 'SuperBot' } } })
    expect(qq.status().state).toBe('connected')

    emitWs({
      op: 0,
      s: 2,
      t: 'GROUP_AT_MESSAGE_CREATE',
      d: {
        id: 'gmsg_1',
        group_openid: 'grp_99',
        content: '<@!bot_1> 你好',
        author: { member_openid: 'mem_77' },
      },
    })
    expect(inbound[0]).toMatchObject({ chatType: 'group', chatId: 'grp_99', from: 'mem_77', text: '你好' })

    // 发送带 Keyboard 按钮的消息 -> 收到 304057 后自动降级为 msg_type=0 纯文本重发
    const rich = buildQqPendingActionPayload({
      actionId: 'a_rich',
      toolName: 'host_shell',
      summary: '验证降级',
    })
    await qq.send({ to: 'mem_77', chatType: 'c2c', replyTo: 'cmsg_1', ...rich })
    const userPosts = sentHttp.filter(x => x.url.includes('/v2/users/mem_77/messages'))
    expect(userPosts).toHaveLength(2)
    expect(userPosts[0]?.body.msg_type).toBe(2)
    expect(userPosts[1]?.body.msg_type).toBe(0)
    expect(userPosts[1]?.body.msg_id).toBe('cmsg_1')
    expect(userPosts[1]?.body.msg_seq).toBe(2)
    expect(qq.status().richDisabled).toBe(true)

    // 触发 INTERACTION_CREATE 按钮回调
    emitWs({
      op: 0,
      s: 3,
      t: 'INTERACTION_CREATE',
      d: {
        id: 'inter_1',
        data: { tag: 'da:a_rich:1' },
        user_openid: 'mem_77',
      },
    })
    await new Promise(r => setTimeout(r, 30))
    expect(interactions[0]?.action).toEqual({ kind: 'director_action', actionId: 'a_rich', decision: 'approve' })
    expect(sentHttp.some(x => x.url.includes('/interactions/inter_1') && x.body?.code === 0)).toBe(true)
    expect(JSON.stringify(events) + JSON.stringify(qq.status())).not.toContain(cfg.appSecret)
    expect(JSON.stringify(events) + JSON.stringify(qq.status())).not.toContain('SECRET_QQ_ACCESS_TOKEN_888')

    // test() 错误时也严格脱敏
    const testOk = await qq.test()
    expect(testOk.ok).toBe(true)
    qq.stop()
  })
})

describe('NovelService chapter edit live progress & onEditSettled', () => {
  it('tracks live edit stages via listRecentEdits and invokes onEditSettled with stats', async () => {
    const dir = tempDir('sa-novel-edit-')
    const db = new DatabaseSync(join(dir, 'novel.db'))
    const store = new NovelStore(db)
    const root = join(dir, 'books')
    const nowIso = '2026-11-25T12:00:00.000Z'
    const settled: any[] = []
    let releaseCall!: () => void
    const callGate = new Promise<void>(r => { releaseCall = r })

    const svc = new NovelService({
      db,
      store,
      root,
      enabled: () => true,
      resolve: () => ({
        provider: 'mock',
        model: 'mock-writer',
        target: { api: 'openai-completions', baseUrl: 'http://127.0.0.1:1', apiKey: 'k', model: 'mock-writer' },
      }),
      record: () => 0.012,
      startArc: async () => ({}),
      onEditSettled: edit => settled.push(edit),
    })

    const { id: bookId } = svc.importBook({
      title: '太初剑录',
      genre: 'xianxia',
      chapterChars: [500, 3000],
      setup: {
        bible: {
          premise: '修仙界试炼，少年凭木剑证道。',
          sellingPoints: ['剑道逆袭'],
          protagonistId: 'lin-chen',
          goldenFinger: { name: '剑意共鸣', rules: ['挥剑悟道'], limits: ['消耗神识'], growth: '渐强' },
          style: { pov: '第三人称', rules: ['短段落'], banned: [] },
          taboos: [],
          compass: { endgame: '剑道飞升', longLines: [] },
        },
        power: {
          realms: [
            { id: 'qi', name: '炼气', order: 1, stages: ['初期', '中期', '后期'], abilities: [], breakthrough: { requires: [], risk: '' } },
            { id: 'ji', name: '筑基', order: 2, stages: ['初期', '中期', '后期'], abilities: [], breakthrough: { requires: [], risk: '' } },
          ],
          crossRealmMaxGap: 1,
        },
        characters: [{
          id: 'lin-chen',
          name: '林尘',
          aliases: [],
          role: 'protagonist',
          realm: { id: 'qi', stage: 0 },
          status: 'alive',
          anchors: ['坚韧'],
          relations: [],
          knows: [],
          firstCh: 0,
          lastSeenCh: 0,
        }],
        world: { factions: [], locations: [{ id: 'shilian', name: '试炼台', region: '东域', note: '' }], routes: [] },
        plan: {
          volumes: [{ n: 1, title: '入门', goal: '试炼' }],
          arcs: [{ n: 1, volume: 1, title: '初出茅庐', template: '成长突破', goal: '通过试炼', chapters: 5, status: 'done' }],
        },
      },
    })

    const files = new BookFiles(root, bookId)
    const ch1Text = `# 初试锋芒\n\n${'山风猎猎，林尘握紧手中木剑站在试炼台前。'.repeat(28)}`
    files.writeChapter(1, ch1Text)
    store.recordChapter({
      bookId,
      n: 1,
      arc: 1,
      title: '初试锋芒',
      status: 'committed',
      chars: ch1Text.length,
      sha256: 'abc',
      costUsd: 0.01,
      score: 8,
      committedAt: nowIso,
    })

    // 通过 stub 替换 globalThis.fetch 模拟 OpenAI 兼容返回（仅覆盖此 test）
    const origFetch = globalThis.fetch
    globalThis.fetch = (async () => {
      await callGate
      return new Response(JSON.stringify({
        choices: [{ message: { content: `# 初试锋芒\n\n${'狂风骤起，林尘一剑破开云雾，试炼台石柱震颤不止。'.repeat(30)}` } }],
        usage: { prompt_tokens: 120, completion_tokens: 200 },
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch

    try {
      const started = svc.editChapter(bookId, 1, '把出剑场面写得更有张力')
      expect(started.status).toBe('running')
      expect(started.bookTitle).toBe('太初剑录')
      expect(['queued', 'calling_model']).toContain(started.stage)
      expect(started.progressPct).toBeGreaterThanOrEqual(10)

      await new Promise(r => setTimeout(r, 40))
      const inProgress = svc.listRecentEdits(10)
      expect(inProgress).toHaveLength(1)
      expect(inProgress[0]?.stage).toBe('calling_model')
      expect(inProgress[0]?.progressPct).toBe(35)
      expect(inProgress[0]?.stageLabel).toContain('mock/mock-writer')

      releaseCall()
      await new Promise(r => setTimeout(r, 80))

      const afterDone = svc.lastEdit(bookId, 1)!
      expect(afterDone.status).toBe('done')
      expect(afterDone.stage).toBe('done')
      expect(afterDone.progressPct).toBe(100)
      expect(afterDone.charsAfter).toBeGreaterThan(afterDone.charsBefore!)
      expect(settled).toHaveLength(1)
      expect(settled[0]).toMatchObject({
        id: started.id,
        bookId,
        bookTitle: '太初剑录',
        n: 1,
        status: 'done',
      })

      // 撤销恢复后状态切回 undone
      const undone = svc.undoEdit(bookId, 1)
      expect(undone.status).toBe('undone')
      expect(svc.chapter(bookId, 1).text).toContain('握紧手中木剑')
    } finally {
      globalThis.fetch = origFetch
      db.close()
    }
  })
})
