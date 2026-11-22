import { createCipheriv, randomBytes } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { defaultOptions, type WechatOptions } from '../src/admin/options.ts'
import type { Trigger } from '../src/core/model.ts'
import { WechatSource, decryptWechatPayload, wechatSignature } from '../src/sources/wechat.ts'
import { parseWeixinApiJson } from '../src/sources/wechat-ilink.ts'

function encryptWechatPayload(encodingAesKey: string, plainText: string, receiveId: string): string {
  const aesKey = Buffer.from(`${encodingAesKey}=`, 'base64')
  const iv = aesKey.subarray(0, 16)
  const rand = randomBytes(16)
  const msgBuf = Buffer.from(plainText, 'utf8')
  const lenBuf = Buffer.alloc(4)
  lenBuf.writeUInt32BE(msgBuf.length, 0)
  const idBuf = Buffer.from(receiveId, 'utf8')
  const raw = Buffer.concat([rand, lenBuf, msgBuf, idBuf])
  const pad = 32 - (raw.length % 32)
  const padded = Buffer.concat([raw, Buffer.alloc(pad, pad)])
  const cipher = createCipheriv('aes-256-cbc', aesKey, iv)
  cipher.setAutoPadding(false)
  return Buffer.concat([cipher.update(padded), cipher.final()]).toString('base64')
}

describe('WechatSource', () => {
  const servers: Server[] = []
  afterEach(async () => {
    while (servers.length > 0) {
      const s = servers.pop()!
      await new Promise<void>(resolve => s.close(() => resolve()))
    }
  })

  async function startServer(source: WechatSource): Promise<string> {
    const server = createServer((req, res) => { void source.handleHttp(req, res) })
    servers.push(server)
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()))
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  }

  it('verifies WeCom encrypted URL callback and decrypts inbound XML messages into Triggers', async () => {
    const aesKey = randomBytes(32).toString('base64').replace(/=+$/, '').slice(0, 43)
    const token = 'wecom-verify-token'
    const corpId = 'ww1234567890'
    const triggers: Trigger[] = []
    const cfg: WechatOptions = {
      ...defaultOptions({}).wechat,
      enabled: true,
      mode: 'wecom',
      corpId,
      agentId: '1000002',
      corpSecret: 'top-secret-wecom',
      callbackToken: token,
      encodingAesKey: aesKey,
      allowedUsers: ['zhangsan'],
    }
    const source = new WechatSource({ config: () => cfg, onTrigger: t => triggers.push(t) })
    const base = await startServer(source)

    // 1. GET URL verification
    const echostr = encryptWechatPayload(aesKey, 'verify-ok-123', corpId)
    expect(decryptWechatPayload(aesKey, echostr, corpId)).toBe('verify-ok-123')
    const ts = '1700000000'
    const nonce = 'abc999'
    const sig = wechatSignature([token, ts, nonce, echostr])
    const getRes = await fetch(`${base}/wechat/events?msg_signature=${sig}&timestamp=${ts}&nonce=${nonce}&echostr=${encodeURIComponent(echostr)}`)
    expect(getRes.status).toBe(200)
    expect(await getRes.text()).toBe('verify-ok-123')

    // 2. POST encrypted XML message
    const xml = '<xml><FromUserName><![CDATA[zhangsan]]></FromUserName><MsgType><![CDATA[text]]></MsgType><Content><![CDATA[帮我查一下今天任务]]></Content><MsgId>9001</MsgId></xml>'
    const enc = encryptWechatPayload(aesKey, xml, corpId)
    const postSig = wechatSignature([token, ts, nonce, enc])
    const postRes = await fetch(`${base}/wechat/events?msg_signature=${postSig}&timestamp=${ts}&nonce=${nonce}`, {
      method: 'POST',
      headers: { 'content-type': 'application/xml' },
      body: `<xml><Encrypt><![CDATA[${enc}]]></Encrypt></xml>`,
    })
    expect(postRes.status).toBe(200)
    expect(await postRes.text()).toBe('success')
    expect(triggers).toHaveLength(1)
    expect(triggers[0]!.source).toBe('wechat')
    expect(triggers[0]!.actor.id).toBe('zhangsan')
    expect(triggers[0]!.text).toBe('帮我查一下今天任务')
    expect(source.status().received).toBe(1)
  })

  it('supports webhook/bridge JSON inbound with bearer auth and outbound push without leaking secrets', async () => {
    const triggers: Trigger[] = []
    const outbound: { url: string; body: unknown; auth?: string }[] = []
    const cfg: WechatOptions = {
      ...defaultOptions({}).wechat,
      enabled: true,
      mode: 'webhook',
      bridgeUrl: 'https://bridge.internal/send',
      bridgeToken: 'secret-bridge-token-xyz',
      allowedUsers: ['wxid_owner'],
    }
    const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      outbound.push({
        url: String(url),
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
        auth: (init?.headers as Record<string, string>)?.authorization,
      })
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    }) as typeof fetch

    const source = new WechatSource({ config: () => cfg, onTrigger: t => triggers.push(t), fetch: fakeFetch })
    const base = await startServer(source)

    // Unauthorized request is rejected
    const unauth = await fetch(`${base}/wechat/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ from: 'wxid_owner', text: 'hi' }),
    })
    expect(unauth.status).toBe(401)

    // Authorized inbound triggers engine
    const ok = await fetch(`${base}/wechat/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer secret-bridge-token-xyz' },
      body: JSON.stringify({ from: 'wxid_owner', messageId: 'm-1', text: '跑一下内部安全测试' }),
    })
    expect(ok.status).toBe(200)
    expect(triggers).toHaveLength(1)
    expect(triggers[0]!.text).toBe('跑一下内部安全测试')

    // Outbound message uses bridge + Bearer token
    await source.sendNew({ to: 'wxid_owner', title: '测试标题', text: '测试正文' })
    expect(outbound).toHaveLength(1)
    expect(outbound[0]!.url).toBe('https://bridge.internal/send')
    expect(outbound[0]!.auth).toBe('Bearer secret-bridge-token-xyz')
    expect(outbound[0]!.body).toEqual({ to: 'wxid_owner', title: '测试标题', text: '测试正文' })
  })

  it('rejects unauthenticated callbacks when tokens are missing and enforces encryption on WeCom', async () => {
    const triggers: Trigger[] = []
    const webhookNoToken: WechatOptions = {
      ...defaultOptions({}).wechat,
      enabled: true,
      mode: 'webhook',
      bridgeToken: '',
      callbackToken: '',
    }
    const base1 = await startServer(new WechatSource({ config: () => webhookNoToken, onTrigger: t => triggers.push(t) }))
    const res1 = await fetch(`${base1}/wechat/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ from: 'attacker', text: 'run shell' }),
    })
    expect(res1.status).toBe(401)

    const wecomNoToken: WechatOptions = {
      ...defaultOptions({}).wechat,
      enabled: true,
      mode: 'wecom',
      callbackToken: '',
    }
    const base2 = await startServer(new WechatSource({ config: () => wecomNoToken, onTrigger: t => triggers.push(t) }))
    const res2 = await fetch(`${base2}/wechat/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/xml' },
      body: '<xml><FromUserName><![CDATA[attacker]]></FromUserName><MsgType><![CDATA[text]]></MsgType><Content><![CDATA[hi]]></Content></xml>',
    })
    expect(res2.status).toBe(403)

    const aesKey = randomBytes(32).toString('base64').replace(/=+$/, '').slice(0, 43)
    const wecomEncrypted: WechatOptions = {
      ...defaultOptions({}).wechat,
      enabled: true,
      mode: 'wecom',
      corpId: 'ww123',
      callbackToken: 'tok',
      encodingAesKey: aesKey,
    }
    const base3 = await startServer(new WechatSource({ config: () => wecomEncrypted, onTrigger: t => triggers.push(t) }))
    const sig = wechatSignature(['tok', '1', '2'])
    const res3 = await fetch(`${base3}/wechat/events?signature=${sig}&timestamp=1&nonce=2`, {
      method: 'POST',
      headers: { 'content-type': 'application/xml' },
      body: '<xml><FromUserName><![CDATA[u]]></FromUserName><MsgType><![CDATA[text]]></MsgType><Content><![CDATA[plain]]></Content></xml>',
    })
    expect(res3.status).toBe(403)
    expect(triggers).toHaveLength(0)
  })

  it('refreshes expired WeCom access_token on errcode 42001 and catches WeCom webhook JSON errors', async () => {
    let tokenCalls = 0
    let sendCalls = 0
    const wecomCfg: WechatOptions = {
      ...defaultOptions({}).wechat,
      enabled: true,
      mode: 'wecom',
      corpId: 'ww1',
      agentId: '10001',
      corpSecret: 'sec1',
    }
    const fakeFetch = (async (url: string | URL | Request) => {
      const s = String(url)
      if (s.includes('/cgi-bin/gettoken')) {
        tokenCalls += 1
        return new Response(JSON.stringify({ errcode: 0, access_token: `tok-${tokenCalls}`, expires_in: 7200 }), { status: 200 })
      }
      if (s.includes('/cgi-bin/message/send')) {
        sendCalls += 1
        if (sendCalls === 1) return new Response(JSON.stringify({ errcode: 42001, errmsg: 'access_token expired' }), { status: 200 })
        return new Response(JSON.stringify({ errcode: 0, errmsg: 'ok' }), { status: 200 })
      }
      return new Response(JSON.stringify({ errcode: 93000, errmsg: 'invalid webhook' }), { status: 200 })
    }) as typeof fetch

    const wecom = new WechatSource({ config: () => wecomCfg, onTrigger: () => {}, fetch: fakeFetch })
    await wecom.sendNew({ to: 'zhangsan', text: 'hello' })
    expect(tokenCalls).toBe(2)
    expect(sendCalls).toBe(2)

    const webhookCfg: WechatOptions = {
      ...defaultOptions({}).wechat,
      enabled: true,
      mode: 'webhook',
      webhookUrl: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=fake',
    }
    const bot = new WechatSource({ config: () => webhookCfg, onTrigger: () => {}, fetch: fakeFetch })
    await expect(bot.sendNew({ text: 'test' })).rejects.toThrow(/93000/)
  })

  it('completes personal WeChat iLink QR login, long-polls messages, and replies with context_token', async () => {
    expect(parseWeixinApiJson<{ message_id: string }>('{"message_id": 9007199254740993123}')).toEqual({
      message_id: '9007199254740993123',
    })

    const triggers: Trigger[] = []
    const sentPayloads: any[] = []
    let qrPolls = 0
    let updatePolls = 0
    let connectedUser = ''

    const cfg: WechatOptions = {
      ...defaultOptions({}).wechat,
      enabled: false,
      mode: 'ilink',
      allowedUsers: [],
    }

    const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const s = String(url)
      if (s.includes('ilink/bot/get_bot_qrcode')) {
        return new Response(JSON.stringify({
          ret: 0,
          qrcode: 'qr-abc-123',
          qrcode_img_content: 'https://liteapp.weixin.qq.com/q/7GiQu1?qrcode=qr-abc-123&bot_type=3',
        }), { status: 200 })
      }
      if (s.includes('ilink/bot/get_qrcode_status')) {
        qrPolls += 1
        if (qrPolls === 1) {
          return new Response(JSON.stringify({ status: 'scaned_but_redirect', redirect_host: 'sz-ilink.weixin.qq.com' }), { status: 200 })
        }
        if (qrPolls === 2) {
          expect(s).toContain('https://sz-ilink.weixin.qq.com/')
          return new Response(JSON.stringify({ status: 'need_verifycode' }), { status: 200 })
        }
        expect(s).toContain('verify_code=8866')
        return new Response(JSON.stringify({
          status: 'confirmed',
          bot_token: 'ilink-secret-bot-token',
          ilink_bot_id: 'bot_001',
          ilink_user_id: 'wxuser_ghost',
          baseurl: 'https://sz-ilink.weixin.qq.com',
        }), { status: 200 })
      }
      if (s.includes('ilink/bot/getupdates')) {
        updatePolls += 1
        if (updatePolls === 1) {
          return new Response(
            '{"ret":0,"get_updates_buf":"buf-1","msgs":[{"message_id":9007199254740993999,"from_user_id":"wxuser_ghost","message_type":1,"context_token":"ctx-tok-777","item_list":[{"type":1,"text_item":{"text":"帮我看看今天服务器状态"}}]}]}',
            { status: 200 },
          )
        }
        // Hold second poll until aborted by stop()
        await new Promise<void>((_, reject) => {
          init?.signal?.addEventListener('abort', () => {
            const err = new Error('aborted')
            err.name = 'AbortError'
            reject(err)
          }, { once: true })
        })
        return new Response(JSON.stringify({ ret: 0, msgs: [] }), { status: 200 })
      }
      if (s.includes('ilink/bot/sendmessage')) {
        sentPayloads.push({
          auth: (init?.headers as Record<string, string>)?.Authorization,
          body: JSON.parse(String(init?.body)),
        })
        return new Response('{"ret":0,"message_id":9007199254740994000}', { status: 200 })
      }
      return new Response(JSON.stringify({ ret: 0, typing_ticket: 'tt-1' }), { status: 200 })
    }) as typeof fetch

    let source!: WechatSource
    source = new WechatSource({
      config: () => cfg,
      onTrigger: t => triggers.push(t),
      onIlinkConnected: ({ userId }) => {
        connectedUser = userId
        cfg.enabled = true
        cfg.allowedUsers = [userId]
        source.start()
      },
      fetch: fakeFetch,
    })

    const qrStart = await source.startQrLogin()
    expect(qrStart.status).toBe('waiting')
    expect(qrStart.qrSvgDataUrl).toMatch(/^data:image\/svg\+xml;base64,/)

    // Wait for redirect -> need_verifycode
    for (let i = 0; i < 40 && source.qrStatus().status !== 'need_verifycode'; i += 1) {
      await new Promise(r => setTimeout(r, 20))
    }
    expect(source.qrStatus().status).toBe('need_verifycode')

    source.submitQrVerifyCode('8866')
    for (let i = 0; i < 40 && source.qrStatus().status !== 'confirmed'; i += 1) {
      await new Promise(r => setTimeout(r, 20))
    }
    expect(source.qrStatus().status).toBe('confirmed')
    expect(connectedUser).toBe('wxuser_ghost')

    // Wait for long-poll message intake
    for (let i = 0; i < 40 && triggers.length === 0; i += 1) {
      await new Promise(r => setTimeout(r, 20))
    }
    expect(triggers).toHaveLength(1)
    expect(triggers[0]!.actor.id).toBe('wxuser_ghost')
    expect(triggers[0]!.text).toBe('帮我看看今天服务器状态')

    await source.sendNew({ text: '服务器一切正常！' })
    expect(sentPayloads).toHaveLength(1)
    expect(sentPayloads[0]!.auth).toBe('Bearer ilink-secret-bot-token')
    expect(sentPayloads[0]!.body.msg).toMatchObject({
      from_user_id: '',
      to_user_id: 'wxuser_ghost',
      message_type: 2,
      message_state: 2,
      context_token: 'ctx-tok-777',
      item_list: [{ type: 1, text_item: { text: '服务器一切正常！' } }],
    })
    expect(String(sentPayloads[0]!.body.msg.client_id)).toMatch(/^[0-9a-f-]{36}$/i)
    expect(sentPayloads[0]!.body.base_info).toEqual({ channel_version: 'aq-wechat-2' })

    // Public status never exposes bot_token
    expect(JSON.stringify(source.status())).not.toContain('ilink-secret-bot-token')
    await source.logoutIlink()
    expect(source.status().ilink?.bound).toBe(false)
  })

  it('routes iLink requests through configured relay with token header, skips typing spam, and warns when message_id is omitted', async () => {
    const calls: { url: string; method: string; headers: Record<string, string> }[] = []
    const events: { kind: string; level: string; text: string; data?: Record<string, unknown> }[] = []
    const cfg: WechatOptions = {
      ...defaultOptions({}).wechat,
      enabled: true,
      mode: 'ilink',
      allowedUsers: ['wxuser_silent'],
      ilinkRelayUrl: 'https://relay.example.com/sa-ilink-relay',
      ilinkRelayToken: 'relay-secret-xyz',
    }
    const store = new (await import('../src/sources/wechat-ilink.ts')).InMemoryIlinkStore()
    store.save({
      botToken: 'tok-silent',
      accountId: 'bot_silent',
      userId: 'wxuser_silent',
      baseUrl: 'https://ilinkai.weixin.qq.com',
      syncBuf: '',
      contextTokens: { wxuser_silent: 'ctx-1' },
      boundAt: new Date().toISOString(),
    })
    const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const s = String(url)
      calls.push({
        url: s,
        method: init?.method ?? 'GET',
        headers: (init?.headers as Record<string, string>) ?? {},
      })
      if (s.includes('ilink/bot/sendmessage')) {
        // 模拟腾讯 iLink 静默丢弃：HTTP 200 ret=0 但无 message_id
        return new Response(JSON.stringify({ ret: 0 }), { status: 200 })
      }
      return new Response(JSON.stringify({ ret: 0 }), { status: 200 })
    }) as typeof fetch

    const source = new WechatSource({
      config: () => cfg,
      onTrigger: () => {},
      onEvent: e => events.push(e),
      ilinkStore: store,
      fetch: fakeFetch,
    })

    // 极简低风控模式默认不发 sendtyping 请求
    await source.sendTyping('wxuser_silent', 1)
    await source.sendTyping('wxuser_silent', 2)
    expect(calls).toHaveLength(0)

    await source.sendNew({ to: 'wxuser_silent', text: '测试中继与静默丢弃告警' })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe('https://relay.example.com/sa-ilink-relay/ilink/bot/sendmessage')
    expect(calls[0]!.headers['X-Ilink-Relay-Token']).toBe('relay-secret-xyz')
    expect(calls[0]!.headers['iLink-App-Id']).toBeUndefined()
    expect(events).toHaveLength(1)
    expect(events[0]!.kind).toBe('wechat.sent')
    expect(events[0]!.level).toBe('warn')
    expect(events[0]!.data?.silentDropSuspected).toBe(true)
  })
})
