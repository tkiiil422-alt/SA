/**
 * Feishu conversation continuation (round R2): the pure intent/candidate rules, plus the runtime intake path both Feishu
 * transports use. The runtime test feeds p2p Triggers through `runtime.feishuIntake` with the fake Pi and a local Feishu
 * API stub; nothing touches the network.
 */
import { createServer, type Server } from 'node:http'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { parseConfig, type Config } from '../src/config.ts'
import { createRuntime, type Runtime } from '../src/runtime.ts'
import type { Trigger } from '../src/core/model.ts'
import { triggerFromMessageEvent } from '../src/sources/feishu.ts'
import {
  continuationIntent, pickContinuation, FEISHU_CONTINUE_WINDOW_MS,
  type ContinuationCandidate,
} from '../src/sources/feishu-continue.ts'

const FAKE_PI = fileURLToPath(new URL('./fixtures/fake-pi.mjs', import.meta.url))
const CHAT = 'oc_private_chat'
const NOW = new Date('2026-11-05T12:00:00.000Z')

const runtimes: Runtime[] = []
const directories: string[] = []
const servers: Server[] = []
/** Keep the daemon's startup backups inside the OS temp directory, never the operator's home. */
process.env.SA_BACKUP_DIR = mkdtempSync(join(tmpdir(), 'superagent-continue-backups-'))

function tempDir(): string {
  const directory = mkdtempSync(join(tmpdir(), 'superagent-continue-'))
  directories.push(directory)
  return directory
}

afterEach(async () => {
  for (const runtime of runtimes.splice(0).reverse()) {
    try { await runtime.stop() } catch { /* already stopped */ }
  }
  for (const server of servers.splice(0)) {
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function configFor(stateDir: string): Config {
  return parseConfig({
    stateDir,
    maxSlots: 2,
    operatorId: 'operator',
    launcher: { command: process.execPath, args: [FAKE_PI], env: { FAKE_PI_REPORT_READY: '1', FAKE_PI_RUN_MS: '20' } },
    policy: {
      policy: { sources: { feishu: { allowed: [{ id: 'ou_user', name: 'User' }] } } },
      eval: { mode: 'auto' },
    },
  })
}

async function until(check: () => boolean, label: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`)
    await new Promise(resolveSleep => setTimeout(resolveSleep, 10))
  }
}

interface StubReply { messageId: string; text: string }

/** A local stand-in for Feishu's Open API: tenant token plus message replies, recording what was sent where. */
async function startFeishuStub(): Promise<{ url: string; replies: StubReply[] }> {
  const replies: StubReply[] = []
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', chunk => { body += String(chunk) })
    req.on('end', () => {
      res.setHeader('content-type', 'application/json')
      if (req.url?.includes('/auth/v3/tenant_access_token/')) {
        res.end(JSON.stringify({ code: 0, tenant_access_token: 'stub-token', expire: 7200 }))
        return
      }
      const match = req.url?.match(/\/im\/v1\/messages\/([^/]+)\/reply/)
      if (match) {
        const payload = JSON.parse(body) as { content?: string }
        const content = JSON.parse(payload.content ?? '{}') as { text?: string }
        replies.push({ messageId: decodeURIComponent(match[1]!), text: content.text ?? '' })
        res.end(JSON.stringify({ code: 0 }))
        return
      }
      res.statusCode = 404
      res.end(JSON.stringify({ code: 404 }))
    })
  })
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('stub did not bind a port')
  return { url: `http://127.0.0.1:${address.port}`, replies }
}

function feishuTrigger(messageId: string, text: string, openId = 'ou_user'): Trigger {
  const result = triggerFromMessageEvent({
    sender: { sender_type: 'user', sender_id: { open_id: openId } },
    message: {
      message_id: messageId,
      chat_id: CHAT,
      chat_type: 'p2p',
      message_type: 'text',
      content: JSON.stringify({ text }),
      create_time: String(Date.now()),
    },
  }, { groupMode: 'mention' })
  if ('ignored' in result) throw new Error(`unexpected ignore: ${result.ignored}`)
  return result
}

const candidate = (ticketId: string, threadId: string, lastActivityAt: string, endedByHuman = false): ContinuationCandidate =>
  ({ ticketId, threadId, lastActivityAt, endedByHuman })

describe('continuationIntent', () => {
  it('recognizes every new-task prefix and strips it', () => {
    expect(continuationIntent('新任务：写个脚本')).toEqual({ kind: 'new', text: '写个脚本' })
    expect(continuationIntent('新任务: 写个脚本')).toEqual({ kind: 'new', text: '写个脚本' })
    expect(continuationIntent('新任务 写个脚本')).toEqual({ kind: 'new', text: '写个脚本' })
    expect(continuationIntent('/new 写个脚本')).toEqual({ kind: 'new', text: '写个脚本' })
  })

  it('recognizes continue commands', () => {
    expect(continuationIntent('继续：改成红色标题')).toEqual({ kind: 'continue', text: '改成红色标题' })
    expect(continuationIntent('继续: 改成红色标题')).toEqual({ kind: 'continue', text: '改成红色标题' })
    expect(continuationIntent('继续 改成红色标题')).toEqual({ kind: 'continue', text: '改成红色标题' })
    expect(continuationIntent('/continue 改成红色标题')).toEqual({ kind: 'continue', text: '改成红色标题' })
  })

  it('keeps the original text when stripping leaves nothing', () => {
    expect(continuationIntent('新任务：')).toEqual({ kind: 'new', text: '新任务：' })
    expect(continuationIntent('/new')).toEqual({ kind: 'new', text: '/new' })
    expect(continuationIntent('/continue')).toEqual({ kind: 'continue', text: '/continue' })
  })

  it('treats an ordinary message as auto, unchanged', () => {
    expect(continuationIntent('改成红色标题')).toEqual({ kind: 'auto', text: '改成红色标题' })
    expect(continuationIntent('继续改')).toEqual({ kind: 'auto', text: '继续改' })
  })
})

describe('pickContinuation', () => {
  const input = (candidates: ContinuationCandidate[], overrides: Partial<Parameters<typeof pickContinuation>[0]> = {}) => ({
    chatId: CHAT, chatType: 'p2p' as const, now: NOW, windowMs: FEISHU_CONTINUE_WINDOW_MS, candidates, ...overrides,
  })

  it('picks the newest candidate within the window', () => {
    const picked = pickContinuation(input([
      candidate('t-old', `${CHAT}:m1`, '2026-11-04T12:00:00.000Z'),
      candidate('t-new', `${CHAT}:m2`, '2026-11-05T11:00:00.000Z'),
    ]))
    expect(picked).toEqual({ ticketId: 't-new', threadId: `${CHAT}:m2` })
  })

  it('skips a ticket a person stopped', () => {
    const picked = pickContinuation(input([
      candidate('t-stopped', `${CHAT}:m1`, '2026-11-05T11:00:00.000Z', true),
      candidate('t-live', `${CHAT}:m2`, '2026-11-05T10:00:00.000Z'),
    ]))
    expect(picked).toEqual({ ticketId: 't-live', threadId: `${CHAT}:m2` })
  })

  it('skips other chats, including chat ids that share a prefix', () => {
    expect(pickContinuation(input([candidate('t', `${CHAT}0:m1`, '2026-11-05T11:00:00.000Z')]))).toBeUndefined()
  })

  it('never continues a group chat', () => {
    expect(pickContinuation(input([candidate('t', `${CHAT}:m1`, '2026-11-05T11:00:00.000Z')], { chatType: 'group' }))).toBeUndefined()
  })

  it('skips activity outside the window', () => {
    expect(pickContinuation(input([candidate('t', `${CHAT}:m1`, '2026-11-04T11:00:00.000Z')]))).toBeUndefined()
  })
})

describe('Feishu continuation through the runtime intake', () => {
  it('continues the same ended ticket, starts a new one on 新任务, and never merges an unlisted sender', async () => {
    const stateDir = tempDir()
    const stub = await startFeishuStub()
    // The Feishu source must be enabled for its scope to observe p2p messages; credentials are placeholders.
    writeFileSync(join(stateDir, 'options.json'), JSON.stringify({
      feishu: {
        enabled: true, mode: 'webhook', appId: 'cli_test', appSecret: 'secret', verificationToken: 'token',
        encryptKey: '', apiBase: stub.url, groupMode: 'mention',
      },
    }))
    const runtime = await createRuntime(configFor(stateDir))
    runtimes.push(runtime)

    const first = feishuTrigger('m1', '写个 hello.py')
    runtime.feishuIntake(first)
    await until(() => runtime.repo.tickets.list().length === 1, 'the first ticket')
    const ticketId = runtime.repo.tickets.list()[0]!.id
    await until(() => runtime.repo.tickets.get(ticketId)?.ended !== undefined, 'the first ticket to end')

    const second = feishuTrigger('m2', '改成红色标题')
    runtime.feishuIntake(second)
    await until(() => {
      const ticket = runtime.repo.tickets.get(ticketId)
      return !!ticket && ticket.inputs.some(input => input.kind === 'trigger' && input.triggerId === second.id)
        && ticket.assignments.length >= 2
    }, 'the second message to join the same ticket')

    expect(runtime.repo.tickets.list()).toHaveLength(1)
    expect(runtime.repo.triggers.get(second.id)?.threads).toEqual([{ source: 'feishu', id: `${CHAT}:m1` }])
    expect(runtime.repo.triggers.get(second.id)?.text).toBe('改成红色标题')
    // Replies still go under the new message, and the person is told the message merged.
    await until(() => stub.replies.some(reply => reply.messageId === 'm2'), 'the merge acknowledgement')
    expect(stub.replies.find(reply => reply.messageId === 'm2')?.text)
      .toBe('已并入任务「写个 hello.py」。要另开新任务，请以「新任务：」开头。')

    const third = feishuTrigger('m3', '新任务：再写一个 world.py')
    runtime.feishuIntake(third)
    await until(() => runtime.repo.tickets.list().length === 2, 'a second ticket')
    expect(runtime.repo.triggers.get(third.id)?.text).toBe('再写一个 world.py')
    expect(runtime.repo.triggers.get(third.id)?.threads).toEqual([{ source: 'feishu', id: `${CHAT}:m3` }])

    const before = runtime.repo.tickets.list().length
    const unlisted = feishuTrigger('m4', '继续：再改一下', 'ou_other')
    runtime.feishuIntake(unlisted)
    await until(() => runtime.repo.triggers.disposition(unlisted.id)?.decisionId !== undefined, 'the unlisted message decision')
    expect(runtime.repo.tickets.list()).toHaveLength(before)
    expect(runtime.repo.tickets.list().some(ticket =>
      ticket.inputs.some(input => input.kind === 'trigger' && input.triggerId === unlisted.id))).toBe(false)
  }, 30_000)
})
