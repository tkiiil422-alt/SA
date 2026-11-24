import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { createAdminApi } from '../src/admin/api.ts'
import { AdminAuth } from '../src/admin/auth.ts'
import type { AdminHost, TicketDetailView, TicketSummaryView } from '../src/admin/host.ts'
import { OptionsStore, defaultOptions } from '../src/admin/options.ts'
import { DirectorBridge } from '../src/director/bridge.ts'
import { HostOpsService, isSensitiveHostPath } from '../src/director/host-ops.ts'
import { isRetryableNetworkError, retryBackoffMs } from '../src/assessor/model-call.ts'
import { callToolModel, flattenToolHistory, type ToolModelRequest, type ToolModelResult } from '../src/director/llm.ts'
import {
  DirectorService,
  buildConversationWindow,
  computeDirectorContextBudget,
  estimateTextTokens,
  findSafeCompactCutIndex,
} from '../src/director/service.ts'
import { DirectorStore } from '../src/director/store.ts'
import { EventLog } from '../src/ledger/events.ts'
import { Ledger } from '../src/ledger/ledger.ts'
import type { NovelService } from '../src/novel/service.ts'

const dirs: string[] = []
const dbs: DatabaseSync[] = []
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  while (dbs.length > 0) {
    try { dbs.pop()!.close() } catch { /* ignore */ }
  }
  while (dirs.length > 0) {
    rmSync(dirs.pop()!, { recursive: true, force: true })
  }
})

function makeFakeHost(workspaceRoot: string) {
  let paused = false
  const created: { text: string; model?: string; secrets?: string[]; projectId?: string }[] = []
  const deleted: string[] = []
  const replies: { id: string; text: string }[] = []
  const decidedSecrets: { id: string; decision: 'grant' | 'deny' }[] = []
  let policyState = {
    paused: false,
    acceptMode: 'auto' as 'off' | 'observe' | 'auto',
    evalTimeoutSeconds: 30,
    rules: [] as { id: string; name: string; enabled: boolean; instruction: string }[],
    allowedOperators: [] as { id: string; name: string }[],
    feishuOperators: [] as { id: string; name: string }[],
  }
  let githubToken = 'ghp_initial'
  let emailPassword = ''
  let emailAllowedSenders: string[] = []
  let emailRestarts = 0
  let wechatAllowedUsers: string[] = []
  let wechatLoggedOut = false
  const discoverCalls: unknown[] = []

  const tickets: TicketSummaryView[] = [
    {
      id: 't_alpha',
      title: '构建数据看板',
      status: 'open',
      stage: { stage: 'working' },
      needsPerson: false,
      createdAt: '2026-11-21T01:00:00.000Z',
      updatedAt: '2026-11-21T02:00:00.000Z',
      costUsd: 0.1234,
    },
  ]

  const host = {
    info: () => ({
      version: '0.1.0', uptimeSec: 3600, startedAt: '2026-11-21T00:00:00.000Z',
      node: 'v22.23.4', platform: 'linux', stateDir: '/tmp/state', configPath: '', gatewayUrl: '', mcpUrl: '',
    }),
    overview: () => ({
      paused,
      acceptMode: 'auto' as const,
      slots: { used: 1, max: 2, reservedForPerson: 1 },
      tickets: { open: 1, running: 1, needsPerson: 0, endedToday: 2 },
      attentionTickets: [],
      runningSteps: [{ id: 't_alpha', summary: 'npm test', kind: 'tool', tool: 'bash', status: 'running', at: '2026-11-21T02:00:00.000Z' }],
      host: { load1: 0.42, cpuCount: 4, memUsedPct: 35, diskFreeGb: 256.5 },
      upstream: { ok: true, model: 'deepseek-v4.1-flash', provider: '默认服务' },
    }),
    listTickets: () => ({ total: tickets.length, items: tickets }),
    ticket: (id: string): TicketDetailView | undefined => {
      const t = tickets.find(x => x.id === id)
      if (!t) return undefined
      return {
        ...t,
        model: { ref: 'default/deepseek-v4.1-flash', label: 'DeepSeek', providerName: '默认服务', source: 'default' },
        mandate: { strength: 'explicit', actor: { source: 'cli', id: 'op' }, scope: 'test', policyVersion: '1' },
        secrets: ['API_TOKEN'],
        assignments: [],
        reports: [],
        canRetry: false,
        inputs: [],
        messages: [],
        workspace: { path: join(workspaceRoot, id), exists: true, fileCount: 2 },
      }
    },
    ticketPreviews: () => [{ port: 19000, title: '前端预览', path: 'p/tok/', url: 'http://127.0.0.1:8787/p/tok/', active: true }],
    ticketLinks: () => [{ kind: 'pr', url: 'https://github.com/org/repo/pull/7', title: 'PR #7' }],
    deliverables: () => [{ path: 'output/report.md', size: 120, mtime: '2026-11-21T02:00:00.000Z', kind: 'md' }],
    workspaceRoot: (id: string) => join(workspaceRoot, id),
    ticketTitles: (ids: readonly string[]) => Object.fromEntries(ids.map(id => [id, tickets.find(t => t.id === id)?.title ?? ''])),
    createTicket: async (text: string, model?: string, secrets?: string[], projectId?: string) => {
      const ticketId = `t_new_${created.length + 1}`
      created.push({ text, ...(model ? { model } : {}), ...(secrets ? { secrets } : {}), ...(projectId ? { projectId } : {}) })
      tickets.push({
        id: ticketId, title: text.slice(0, 30), status: 'open', stage: { stage: 'working', action: 'queued' }, needsPerson: false,
        createdAt: '2026-11-21T02:10:00.000Z', updatedAt: '2026-11-21T02:10:00.000Z', costUsd: 0,
      })
      return { ticketId, triggerId: `tr_${ticketId}`, threadId: `th_${ticketId}`, threadKey: `cli:th_${ticketId}`, decision: 'accept' }
    },
    listSecrets: () => [{ name: 'API_TOKEN', description: '外部接口令牌', origin: 'operator' as const, createdAt: '2026-11-21T00:00:00.000Z', grantedTickets: 1 }],
    secretRequests: () => [{ id: 'req_1', ticketId: 't_alpha', ticketTitle: '构建数据看板', name: 'PROD_KEY', why: '需要查询指标', at: '2026-11-21T02:00:00.000Z', status: 'pending' as const }],
    decideSecretRequest: (id: string, decision: 'grant' | 'deny') => {
      decidedSecrets.push({ id, decision })
      return { ok: true as const }
    },
    replyTicket: (id: string, text: string) => { replies.push({ id, text }) },
    noteTicket: () => undefined,
    retryTicket: () => undefined,
    stopTicket: () => undefined,
    deleteTicket: (id: string) => {
      deleted.push(id)
      return { ok: true as const, freedBytes: 4096 }
    },
    setPaused: (p: boolean) => {
      const changed = paused !== p
      paused = p
      return { paused, changed }
    },
    decisions: () => [],
    getPolicy: () => ({ ...policyState, paused }),
    updatePolicy: (next: typeof policyState) => {
      paused = next.paused
      policyState = { ...next }
      return { changed: ['policy'] }
    },
    system: async () => ({ containers: [], disk: { workspacesMb: 12, piConfigMb: 2, dbMb: 1, freeGb: 256 }, limits: { maxWorkers: 2 } }),
    backups: () => ({ dir: '/tmp/backups', items: [] }),
    createBackup: async () => ({ ok: true as const, item: { name: 'state-test.tgz', at: '2026-11-21T02:00:00.000Z', bytes: 1024 } }),
    cleanup: async ({ olderThanDays, dryRun }: { olderThanDays: number; dryRun: boolean }) => ({
      dryRun, olderThanDays, entries: [], deleted: [], freedBytes: 0,
    }),
    feishuStatus: () => ({ mode: 'ws' as const, state: 'off' as const }),
    emailStatus: () => ({ state: 'off' as const, processed: 0 }),
    emailPasswordSet: () => emailPassword.length > 0,
    setEmailPassword: (pwd: string) => { emailPassword = pwd },
    setEmailAllowedSenders: (senders: readonly string[]) => { emailAllowedSenders = [...senders]; return { changed: true } },
    restartEmail: () => { emailRestarts += 1 },
    wechatStatus: () => ({
      state: 'connected' as const, mode: 'ilink' as const, received: 1, sent: 1,
      ilink: { bound: !wechatLoggedOut, accountId: 'bot1', userId: 'wx_owner_1' },
    }),
    setWechatAllowedUsers: (users: readonly string[]) => { wechatAllowedUsers = [...users]; return { changed: true } },
    wechatQrStatus: () => ({ active: false, status: 'idle' as const, message: '未发起', updatedAt: '2026-11-21T02:00:00.000Z' }),
    logoutWechatIlink: async () => { wechatLoggedOut = true },
    githubTokenSet: () => githubToken.length > 0,
    setGithubToken: (tok: string) => { githubToken = tok },
    discoverModels: async (input: unknown) => {
      discoverCalls.push(input)
      return { ok: true, status: 200, message: '发现 2 个模型', models: [{ id: 'claude-sonnet-4' }, { id: 'gemini-3-pro' }] }
    },
  } as unknown as AdminHost

  return {
    host, created, deleted, replies, decidedSecrets,
    getPaused: () => paused,
    getGithubToken: () => githubToken,
    getEmailPassword: () => emailPassword,
    getEmailAllowedSenders: () => emailAllowedSenders,
    getEmailRestarts: () => emailRestarts,
    getWechatAllowedUsers: () => wechatAllowedUsers,
    isWechatLoggedOut: () => wechatLoggedOut,
    discoverCalls,
  }
}

describe('director llm tool-calling adapters', () => {
  it('parses OpenAI SSE streamed tool_calls and usage', async () => {
    const sse = [
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"platform_","arguments":"{\\"ran"}}]}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"overview","arguments":"ge\\":\\"today\\"}"}}]}}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":100,"completion_tokens":20,"prompt_tokens_details":{"cached_tokens":60}}}\n\n',
      'data: [DONE]\n\n',
    ].join('')
    const fakeFetch: typeof fetch = async () => new Response(sse, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    })
    const res = await callToolModel(
      { api: 'openai-completions', baseUrl: 'https://api.example.com/v1', apiKey: 'sk-secret-xyz' },
      { model: 'm1', system: 'sys', messages: [{ role: 'user', content: '查状态' }], tools: [{ name: 'platform_overview', description: 'ov', parameters: { type: 'object', properties: {} } }], maxTokens: 512 },
      { timeoutMs: 5000, stream: true, fetch: fakeFetch },
    )
    expect(res.ok).toBe(true)
    expect(res.toolCalls).toEqual([{ id: 'call_1', name: 'platform_overview', arguments: { range: 'today' } }])
    expect(res.usage?.prompt_cache_hit_tokens).toBe(60)
    expect(res.usage?.completion_tokens).toBe(20)
  })

  it('formats Anthropic tool_result blocks cleanly with cache_control and parses tool_use', async () => {
    let capturedBody: any
    const fakeFetch: typeof fetch = async (_url, init) => {
      capturedBody = JSON.parse(String(init?.body))
      return new Response(JSON.stringify({
        content: [
          { type: 'text', text: '我来查一下' },
          { type: 'tool_use', id: 'tu_1', name: 'tickets_list', input: { status: 'open' } },
        ],
        stop_reason: 'tool_use',
        usage: { input_tokens: 80, cache_read_input_tokens: 40, output_tokens: 30 },
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    const res = await callToolModel(
      { api: 'anthropic-messages', baseUrl: 'https://api.anthropic.com', apiKey: 'sk-ant-secret' },
      {
        model: 'claude-sonnet',
        system: 'sys',
        messages: [
          { role: 'user', content: 'hi' },
          { role: 'assistant', content: '', toolCalls: [{ id: 't0', name: 'platform_overview', arguments: {} }] },
          { role: 'tool', toolCallId: 't0', name: 'platform_overview', content: '{"ok":true}' },
          { role: 'user', content: '再看任务' },
        ],
        tools: [{ name: 'tickets_list', description: 'list', parameters: { type: 'object', properties: {} } }],
        maxTokens: 512,
      },
      { timeoutMs: 5000, fetch: fakeFetch },
    )
    expect(res.ok).toBe(true)
    expect(res.text).toBe('我来查一下')
    expect(res.toolCalls).toEqual([{ id: 'tu_1', name: 'tickets_list', arguments: { status: 'open' } }])
    expect(capturedBody.system[0].cache_control).toEqual({ type: 'ephemeral' })
    expect(capturedBody.tools[0].cache_control).toEqual({ type: 'ephemeral' })
    // 连续 tool_result + user 合并进同一条 user 消息，不触发 Anthropic 连续同 role 报错
    expect(capturedBody.messages.map((m: any) => m.role)).toEqual(['user', 'assistant', 'user'])
  })

  it('flags toolsUnsupported and redacts apiKey on upstream error', async () => {
    const fakeFetch: typeof fetch = async () => new Response('model does not support tools for sk-leak-9999', { status: 400 })
    const res = await callToolModel(
      { api: 'openai-completions', baseUrl: 'https://api.example.com/v1', apiKey: 'sk-leak-9999' },
      { model: 'm1', system: 'sys', messages: [{ role: 'user', content: 'hi' }], tools: [], maxTokens: 128 },
      { timeoutMs: 5000, fetch: fakeFetch },
    )
    expect(res.ok).toBe(false)
    expect(res.toolsUnsupported).toBe(true)
    expect(res.error).not.toContain('sk-leak-9999')
    expect(res.error).toContain('***')
  })

  it('retries transient ECONNRESET and 502 errors with fresh connection headers and succeeds', async () => {
    const seenConnections: (string | undefined)[] = []
    let calls = 0
    const fakeFetch: typeof fetch = async (_url, init) => {
      calls += 1
      const h = (init?.headers ?? {}) as Record<string, string>
      seenConnections.push(h.connection)
      if (calls === 1) {
        const cause = Object.assign(new Error('socket reset'), { code: 'ECONNRESET' })
        throw new TypeError('fetch failed', { cause })
      }
      if (calls === 2) {
        return new Response('bad gateway', { status: 502 })
      }
      return new Response(JSON.stringify({ content: [{ type: 'text', text: '重试成功' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    const res = await callToolModel(
      { api: 'anthropic-messages', baseUrl: 'https://gw.example.com', apiKey: 'k' },
      { model: 'gemini-4-hydrogen', system: 'sys', messages: [{ role: 'user', content: 'hi' }], tools: [], maxTokens: 128 },
      { timeoutMs: 10_000, fetch: fakeFetch, maxRetries: 3, retryDelayMs: 5 },
    )
    expect(res.ok).toBe(true)
    expect(res.text).toBe('重试成功')
    expect(calls).toBe(3)
    expect(seenConnections).toEqual([undefined, 'close', 'close'])
  })

  it('reports retry count after exhausting ECONNRESET retries and never retries 401', async () => {
    let resetCalls = 0
    const alwaysReset: typeof fetch = async () => {
      resetCalls += 1
      const cause = Object.assign(new Error('socket reset'), { code: 'ECONNRESET' })
      throw new TypeError('fetch failed', { cause })
    }
    const failed = await callToolModel(
      { api: 'anthropic-messages', baseUrl: 'https://gw.example.com', apiKey: 'k' },
      { model: 'm', system: 'sys', messages: [{ role: 'user', content: 'hi' }], tools: [], maxTokens: 64 },
      { timeoutMs: 10_000, fetch: alwaysReset, maxRetries: 2, retryDelayMs: 5 },
    )
    expect(failed.ok).toBe(false)
    expect(resetCalls).toBe(3)
    expect(failed.error).toContain('ECONNRESET')
    expect(failed.error).toContain('已自动重试 2 次')

    let authCalls = 0
    const unauth: typeof fetch = async () => {
      authCalls += 1
      return new Response('unauthorized', { status: 401 })
    }
    const denied = await callToolModel(
      { api: 'anthropic-messages', baseUrl: 'https://gw.example.com', apiKey: 'k' },
      { model: 'm', system: 'sys', messages: [{ role: 'user', content: 'hi' }], tools: [], maxTokens: 64 },
      { timeoutMs: 10_000, fetch: unauth, maxRetries: 3, retryDelayMs: 5 },
    )
    expect(denied.ok).toBe(false)
    expect(authCalls).toBe(1)
  })
})

describe('director service, tools, high-risk confirmation & wechat bridge', () => {
  function setup() {
    const dir = tempDir('sa-director-')
    const db = new DatabaseSync(join(dir, 'state.sqlite'))
    dbs.push(db)
    const options = new OptionsStore(join(dir, 'options.json'), defaultOptions({}))
    options.updateWechat({ enabled: true, mode: 'ilink', routingMode: 'director', allowedUsers: ['wx_owner_1'] })
    options.update('director', { ...options.get().director, debounceMs: 30 })
    const ledger = new Ledger(db)
    const events = new EventLog(db)
    const store = new DirectorStore(db)
    const wsRoot = join(dir, 'workspaces')
    mkdirSync(join(wsRoot, 't_alpha', 'output'), { recursive: true })
    writeFileSync(join(wsRoot, 't_alpha', 'output', 'report.md'), '第一行结论\n包含密钥 SUPER_SECRET_VALUE_999\n第三行')
    writeFileSync(join(wsRoot, 't_alpha', 'output', 'bin.dat'), Buffer.from([0x00, 0x01, 0x02, 0x03]))
    const fake = makeFakeHost(wsRoot)
    const sentWechat: { to?: string; text: string }[] = []
    const typingUsers: string[] = []
    const directCalls: string[] = []
    const redact = (text: string) => text.split('SUPER_SECRET_VALUE_999').join('***')
    return { dir, db, options, ledger, events, store, fake, sentWechat, typingUsers, directCalls, redact }
  }

  it('executes multi-step tool loop, reads workspace safely with redaction, dispatches tickets and records director usage', async () => {
    const env = setup()
    let turn = 0
    const callTool = async (_target: any, req: ToolModelRequest): Promise<ToolModelResult> => {
      turn += 1
      if (turn === 1) {
        return {
          ok: true, status: 200, text: '', latencyMs: 40,
          usage: { prompt_tokens: 200, completion_tokens: 40, prompt_cache_hit_tokens: 100, prompt_cache_miss_tokens: 100 },
          toolCalls: [
            { id: 'c1', name: 'platform_query', arguments: { action: 'ticket_read_file', params_json: JSON.stringify({ ticketId: 't_alpha', path: 'output/report.md' }) } },
            { id: 'c2', name: 'platform_query', arguments: { action: 'ticket_read_file', params_json: JSON.stringify({ ticketId: 't_alpha', path: '../../etc/passwd' }) } },
            { id: 'c3', name: 'platform_query', arguments: { action: 'ticket_read_file', params_json: JSON.stringify({ ticketId: 't_alpha', path: 'output/bin.dat' }) } },
            { id: 'c4', name: 'dispatch_ticket', arguments: { prompt: '修复登录接口超时并补单测' } },
          ],
        }
      }
      // 第二轮验证工具输出已经被脱敏与防注入包裹，并且路径穿越和二进制文件都被拒绝
      const toolMsgs = req.messages.filter(m => m.role === 'tool')
      expect(toolMsgs.length).toBe(4)
      expect(toolMsgs[0]!.content).toContain('[UNTRUSTED_DATA:')
      expect(toolMsgs[0]!.content).toContain('***')
      expect(toolMsgs[0]!.content).not.toContain('SUPER_SECRET_VALUE_999')
      expect(toolMsgs[1]!.content).toContain('越界')
      expect(toolMsgs[2]!.content).toContain('二进制')
      expect(toolMsgs[3]!.content).toContain('t_new_1')
      return {
        ok: true, status: 200, latencyMs: 30, toolCalls: [],
        text: '已审阅 report.md 并为你派发新任务 t_new_1（修复登录接口超时并补单测）。',
        usage: { prompt_tokens: 300, completion_tokens: 50, prompt_cache_hit_tokens: 200, prompt_cache_miss_tokens: 100 },
      }
    }

    const service = new DirectorService({
      host: env.fake.host, options: env.options, ledger: env.ledger, events: env.events,
      store: env.store, redact: env.redact, callTool,
    })

    const res = await service.chat({ channel: 'wechat', userId: 'wx_owner_1', text: '读下 t_alpha 的报告，顺便帮我派一个修登录超时的任务' })
    expect(res.reply).toContain('t_new_1')
    expect(res.toolsUsed.map(t => t.name)).toEqual(['platform_query', 'platform_query', 'platform_query', 'dispatch_ticket'])
    expect(env.fake.created).toHaveLength(1)
    expect(env.store.linksForTicket('t_new_1')).toHaveLength(1)
    // 账本独立记为 agent = 'director'
    const calls = env.ledger.calls({ ticketId: '', limit: 10 })
    expect(calls.filter(c => c.agent === 'director').length).toBe(2)
    service.close()
  })

  it('enforces code-level two-step confirmation for high-risk tools', async () => {
    const env = setup()
    let step = 0
    const callTool = async (): Promise<ToolModelResult> => {
      step += 1
      if (step === 1) {
        return {
          ok: true, status: 200, text: '', latencyMs: 10,
          toolCalls: [{ id: 'del1', name: 'high_risk_action', arguments: { action: 'ticket_delete', params_json: JSON.stringify({ ticketId: 't_alpha', force: true }) } }],
        }
      }
      return { ok: true, status: 200, text: '删除工单属于高危操作，请回复「确认」以继续。', latencyMs: 10, toolCalls: [] }
    }

    const service = new DirectorService({
      host: env.fake.host, options: env.options, ledger: env.ledger, events: env.events,
      store: env.store, redact: env.redact, callTool,
    })

    const first = await service.chat({ channel: 'wechat', userId: 'wx_owner_1', text: '把 t_alpha 彻底删掉' })
    // 未确认前绝不会真正删除
    expect(env.fake.deleted).toEqual([])
    expect(first.pendingActions).toHaveLength(1)
    const code = first.pendingActions[0]!.id

    // 回复「确认」立即执行删除（零模型额外调用）
    const confirmed = await service.chat({ channel: 'wechat', userId: 'wx_owner_1', text: `/确认 ${code}` })
    expect(confirmed.shortcut).toBe('confirm')
    expect(confirmed.reply).toContain('已执行')
    expect(env.fake.deleted).toEqual(['t_alpha'])
    expect(env.store.getPendingAction(code)?.status).toBe('approved')
    service.close()
  })

  it('coalesces rapid WeChat messages, pulses typing, and handles zero-cost shortcuts', async () => {
    const env = setup()
    const seenUserTexts: string[] = []
    const callTool = async (_target: any, req: ToolModelRequest): Promise<ToolModelResult> => {
      const last = req.messages[req.messages.length - 1]
      if (last && last.role === 'user') seenUserTexts.push(last.content)
      return { ok: true, status: 200, text: '收到三条合并消息，已查完。', latencyMs: 10, toolCalls: [] }
    }

    const service = new DirectorService({
      host: env.fake.host, options: env.options, ledger: env.ledger, events: env.events,
      store: env.store, redact: env.redact, callTool,
      sendWechat: async m => { env.sentWechat.push(m) },
      sendWechatTyping: async u => { env.typingUsers.push(u ?? '') },
      directWechatFallback: m => { env.directCalls.push(m.text) },
    })

    // 1. 连续发 3 条短消息，防抖聚合为一次调用
    service.handleWechatInbound({ from: 'wx_owner_1', chatId: 'wx_owner_1', messageId: 'm1', text: '看下爬虫任务' })
    service.handleWechatInbound({ from: 'wx_owner_1', chatId: 'wx_owner_1', messageId: 'm2', text: '顺便看今日花费' })
    service.handleWechatInbound({ from: 'wx_owner_1', chatId: 'wx_owner_1', messageId: 'm3', text: '卡住就告诉我' })
    await new Promise(r => setTimeout(r, 80))
    await service.drain()

    expect(seenUserTexts).toEqual(['看下爬虫任务\n顺便看今日花费\n卡住就告诉我'])
    expect(env.sentWechat).toHaveLength(1)
    expect(env.typingUsers).toContain('wx_owner_1')

    // 2. /状态 零模型开销秒回
    const stRes = await service.chat({ channel: 'wechat', userId: 'wx_owner_1', text: '/状态' })
    expect(stRes.shortcut).toBe('status')
    expect(stRes.reply).toContain('SuperAgent 平台实时状态')
    expect(seenUserTexts).toHaveLength(1)

    // 3. /直通 走原有直通建单链路
    const directRes = await service.chat({
      channel: 'wechat', userId: 'wx_owner_1', text: '/直通 立刻跑一次数据清洗',
      wechatMeta: { chatId: 'wx_owner_1', messageId: 'm4' },
    })
    expect(directRes.shortcut).toBe('direct')
    expect(env.directCalls).toEqual(['立刻跑一次数据清洗'])

    // 4. /新对话 归档上下文但审计保留
    const resetRes = await service.chat({ channel: 'wechat', userId: 'wx_owner_1', text: '/新对话' })
    expect(resetRes.shortcut).toBe('reset')
    expect(env.store.activeMessages(resetRes.sessionId).length).toBe(1) // 仅含 reset 回复
    expect(env.store.recentMessages(resetRes.sessionId).length).toBeGreaterThan(3)
    service.close()
  })

  it('pushes proactive events via DirectorBridge, deduplicates, and queues missed notices on failure', async () => {
    const env = setup()
    let failPush = false
    const service = new DirectorService({
      host: env.fake.host, options: env.options, ledger: env.ledger, events: env.events,
      store: env.store, redact: env.redact,
      callTool: async () => ({ ok: true, status: 200, text: '好的', latencyMs: 10, toolCalls: [] }),
    })
    const bridge = new DirectorBridge({
      director: service,
      options: env.options,
      host: env.fake.host,
      events: env.events,
      sendWechat: async m => {
        if (failPush) throw new Error('network down')
        env.sentWechat.push(m)
      },
    })

    // 1. 工单完成主动汇报 + 去重
    await bridge.notify({
      kind: 'ticket.ended',
      ticketId: 't_alpha',
      title: '构建数据看板',
      outcome: 'completed',
      summary: '已完成图表与接口开发，所有单测通过。',
      costUsd: 0.1234,
      previews: [{ title: '前端预览', url: 'http://127.0.0.1:8787/p/tok/' }],
    })
    await bridge.notify({
      kind: 'ticket.ended',
      ticketId: 't_alpha',
      title: '构建数据看板',
      outcome: 'completed',
      summary: '重复触发应去重',
    })
    expect(env.sentWechat).toHaveLength(1)
    expect(env.sentWechat[0]!.text).toContain('任务已完成：构建数据看板')
    expect(env.sentWechat[0]!.text).toContain('http://127.0.0.1:8787/p/tok/')

    // 会话已记录该事件并自动更新 focusTicketId
    const wxSess = env.store.findSessionByChannelUser('wechat', 'wx_owner_1')!
    expect(wxSess.focusTicketId).toBe('t_alpha')

    // 2. 推送失败时暂存未读，用户下次发消息时自动补报
    failPush = true
    await bridge.notify({
      kind: 'vault.request',
      ticketId: 't_alpha',
      ticketTitle: '构建数据看板',
      requestId: 'req_1',
      name: 'PROD_KEY',
      why: '需要读取线上指标',
    })
    expect(env.sentWechat).toHaveLength(1)

    const nextChat = await service.chat({ channel: 'wechat', userId: 'wx_owner_1', text: '/状态' })
    expect(nextChat.reply).toContain('离线期间补报 1 条')
    expect(nextChat.reply).toContain('PROD_KEY')
    service.close()
  })

  it('routes Feishu private chats through the director with threaded replies and pushes proactive notices to Feishu', async () => {
    const env = setup()
    // 总控切到飞书：关闭微信，开启飞书总控处理方式
    env.options.updateWechat({ enabled: false, mode: 'ilink', routingMode: 'director', allowedUsers: ['wx_owner_1'] })
    env.options.updateFeishu({
      enabled: true, mode: 'ws', appId: 'cli_x', appSecret: 'sec_x', verificationToken: '', encryptKey: '',
      apiBase: 'https://open.feishu.cn', groupMode: 'mention', routingMode: 'director',
    })
    const sentFeishu: { to: string; text: string; replyTo?: string }[] = []
    const seenUserTexts: string[] = []
    const service = new DirectorService({
      host: env.fake.host, options: env.options, ledger: env.ledger, events: env.events,
      store: env.store, redact: env.redact,
      callTool: async (_target: any, req: ToolModelRequest): Promise<ToolModelResult> => {
        const last = req.messages[req.messages.length - 1]
        if (last && last.role === 'user') seenUserTexts.push(last.content)
        return { ok: true, status: 200, text: '**今日花费** $0.12', latencyMs: 10, toolCalls: [] }
      },
      sendWechat: async m => { env.sentWechat.push(m) },
      sendFeishu: async m => { sentFeishu.push(m) },
    })

    service.handleFeishuInbound({ from: 'ou_owner', chatId: 'oc_p2p', messageId: 'om_1', text: '今天花了多少' })
    service.handleFeishuInbound({ from: 'ou_owner', chatId: 'oc_p2p', messageId: 'om_2', text: '顺便看下运行中的任务' })
    await new Promise(r => setTimeout(r, 80))
    await service.drain()

    expect(seenUserTexts).toEqual(['今天花了多少\n顺便看下运行中的任务'])
    expect(sentFeishu).toEqual([{ to: 'ou_owner', text: '**今日花费** $0.12', replyTo: 'om_2' }])
    expect(env.sentWechat).toHaveLength(0)
    const fsSess = env.store.findSessionByChannelUser('feishu', 'ou_owner')!
    expect(fsSess.title).toContain('飞书总控')

    // 控制台在飞书会话里发消息可同步推送到飞书（新消息，不带 replyTo）
    const consoleRes = await service.chat({ channel: 'feishu', userId: 'ou_owner', text: '/状态', deliverToWechat: true })
    expect(consoleRes.wechatDelivered).toBe(true)
    expect(sentFeishu[1]?.to).toBe('ou_owner')
    expect(sentFeishu[1]?.replyTo).toBeUndefined()

    // 主动汇报只推飞书允许名单，不再推微信
    const bridge = new DirectorBridge({
      director: service,
      options: env.options,
      host: env.fake.host,
      events: env.events,
      sendWechat: async m => { env.sentWechat.push(m) },
      sendFeishu: async m => { sentFeishu.push(m) },
      feishuRecipients: () => ['ou_owner'],
    })
    await bridge.notify({ kind: 'ticket.ended', ticketId: 't_alpha', title: '构建数据看板', outcome: 'completed', summary: '全部完成。' })
    expect(sentFeishu).toHaveLength(3)
    expect(sentFeishu[2]!.text).toContain('任务已完成：构建数据看板')
    expect(env.sentWechat).toHaveLength(0)
    expect(env.store.findSessionByChannelUser('feishu', 'ou_owner')!.focusTicketId).toBe('t_alpha')
    service.close()
  })

  it('builds clean conversation windows without orphaned tool results', () => {
    const now = '2026-11-21T00:00:00.000Z'
    const msgs = [
      { id: 1, sessionId: 's', role: 'tool' as const, content: 'orphan', toolCallId: 'x', archived: false, createdAt: now },
      { id: 2, sessionId: 's', role: 'user' as const, content: 'q1', archived: false, createdAt: now },
      { id: 3, sessionId: 's', role: 'assistant' as const, content: '', toolCalls: [{ id: 'c1', name: 't', arguments: {} }], archived: false, createdAt: now },
      { id: 4, sessionId: 's', role: 'tool' as const, content: 'ok', toolCallId: 'c1', toolName: 't', archived: false, createdAt: now },
      { id: 5, sessionId: 's', role: 'assistant' as const, content: 'a1', archived: false, createdAt: now },
    ]
    const win = buildConversationWindow(msgs)
    expect(win.map(m => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant'])
  })

  it('serves /api/settings/director and /api/director/* endpoints cleanly', async () => {
    const env = setup()
    const auth = new AdminAuth({ stateDir: env.dir })
    auth.init()
    const director = new DirectorService({
      host: env.fake.host, options: env.options, ledger: env.ledger, events: env.events,
      store: env.store, redact: env.redact,
      sendWechat: async m => { env.sentWechat.push(m) },
      callTool: async () => ({ ok: true, status: 200, text: '平台一切正常', latencyMs: 15, toolCalls: [] }),
    })
    const api = createAdminApi({
      host: env.fake.host, auth, options: env.options, ledger: env.ledger, events: env.events,
      cliToken: 'tok-test', director,
    })

    async function callApi(method: string, path: string, body?: unknown) {
      let status = 200
      const headers: Record<string, string> = {}
      let raw = ''
      const req = {
        method,
        url: path,
        headers: { authorization: 'Bearer tok-test', ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
        socket: { remoteAddress: '127.0.0.1' },
        on(ev: string, fn: (chunk?: Buffer) => void) {
          if (ev === 'data' && body !== undefined) fn(Buffer.from(JSON.stringify(body)))
          if (ev === 'end') fn()
        },
      } as any
      const res = {
        writeHead(s: number, h?: Record<string, string>) { status = s; Object.assign(headers, h ?? {}) },
        setHeader(k: string, v: string) { headers[k.toLowerCase()] = v },
        end(chunk?: string | Buffer) { if (chunk) raw += chunk.toString() },
      } as any
      await api(req, res)
      return { status, json: raw ? JSON.parse(raw) : undefined }
    }

    const getSet = await callApi('GET', '/api/settings/director')
    expect(getSet.status).toBe(200)
    expect(getSet.json.enabled).toBe(true)

    const putSet = await callApi('PUT', '/api/settings/director', { ...getSet.json, notifyScope: 'wechat_only', maxToolSteps: 6, maxRetries: 10 })
    expect(putSet.status).toBe(200)
    expect(env.options.get().director.notifyScope).toBe('wechat_only')
    expect(env.options.get().director.maxToolSteps).toBe(6)
    expect(env.options.get().director.maxRetries).toBe(10)

    const badRetries = await callApi('PUT', '/api/settings/director', { ...getSet.json, maxRetries: 25 })
    expect(badRetries.status).toBe(400)

    const chatRes = await callApi('POST', '/api/director/chat', { text: '你好总控', channel: 'web', userId: 'console' })
    expect(chatRes.status).toBe(200)
    expect(chatRes.json.reply).toBe('平台一切正常')

    const wxChat = await callApi('POST', '/api/director/chat', { text: '/状态', channel: 'wechat', userId: 'wx_owner_1', deliverToWechat: true })
    expect(wxChat.status).toBe(200)
    expect(wxChat.json.wechatDelivered).toBe(true)
    expect(env.sentWechat).toHaveLength(1)

    const listRes = await callApi('GET', '/api/director/sessions')
    expect(listRes.status).toBe(200)
    expect(listRes.json.items.length).toBe(2)

    const detailRes = await callApi('GET', `/api/director/sessions/${encodeURIComponent(chatRes.json.sessionId)}`)
    expect(detailRes.status).toBe(200)
    expect(detailRes.json.messages.length).toBeGreaterThanOrEqual(2)
    director.close()
  })

  it('requires two-step confirmation before executing project_snapshot_delete', async () => {
    const env = setup()
    const deletedSnapshots: Array<{ projectId: string; sha: string }> = []
    const fakeProjects = {
      get: (id: string) => (id === 'p_demo1' ? { id, name: '演示项目', status: 'ready', files: 1, bytes: 10, createdAt: '', sourceName: '', archiveBytes: 0, updatedAt: '', warnings: [], progress: { done: 1, total: 1 } } : undefined),
      snapshots: async () => [{ sha: 'abcdef1234567890abcdef1234567890abcdef12', at: '2026-11-21T00:00:00Z', message: '旧版本快照' }],
      deleteSnapshot: async (projectId: string, sha: string) => {
        deletedSnapshots.push({ projectId, sha })
        return { deleted: sha, remaining: 0, freedBytes: 1024 }
      },
    } as any
    let step = 0
    const callTool = async (): Promise<ToolModelResult> => {
      step += 1
      if (step === 1) {
        return {
          ok: true, status: 200, text: '', latencyMs: 10,
          toolCalls: [{
            id: 'psdel1',
            name: 'high_risk_action',
            arguments: { action: 'project_snapshot_delete', params_json: JSON.stringify({ projectId: 'p_demo1', snapshot: 'abcdef1234567890' }) },
          }],
        }
      }
      return { ok: true, status: 200, text: '删除历史快照需要确认，请回复「确认」。', latencyMs: 10, toolCalls: [] }
    }
    const service = new DirectorService({
      host: env.fake.host, options: env.options, ledger: env.ledger, events: env.events,
      store: env.store, redact: env.redact, projects: fakeProjects, callTool,
    })

    const first = await service.chat({ channel: 'wechat', userId: 'wx_owner_1', text: '把演示项目的旧快照删了' })
    expect(deletedSnapshots).toEqual([])
    expect(first.pendingActions).toHaveLength(1)
    expect(first.pendingActions[0]!.summary).toContain('旧版本快照')

    const confirmed = await service.chat({ channel: 'wechat', userId: 'wx_owner_1', text: `/确认 ${first.pendingActions[0]!.id}` })
    expect(confirmed.shortcut).toBe('confirm')
    expect(deletedSnapshots).toEqual([{ projectId: 'p_demo1', sha: 'abcdef1234567890' }])
    service.close()
  })

  it('passes configured director.maxRetries and scales timeout budget for tool & summary calls', async () => {
    const env = setup()
    env.options.update('director', { ...env.options.get().director, maxRetries: 10 })

    const seenToolOpts: Array<{ maxRetries?: number; timeoutMs: number }> = []
    const seenPlainOpts: Array<{ maxRetries?: number; timeoutMs: number }> = []
    const service = new DirectorService({
      host: env.fake.host,
      options: env.options,
      ledger: env.ledger,
      events: env.events,
      store: env.store,
      redact: env.redact,
      callTool: async (_target, _req, opts) => {
        seenToolOpts.push({ maxRetries: opts.maxRetries, timeoutMs: opts.timeoutMs })
        return { ok: true, status: 200, text: '已按配置重试上限调用', latencyMs: 12, toolCalls: [] }
      },
      callPlain: async (_target, _req, opts) => {
        seenPlainOpts.push({ maxRetries: opts.maxRetries, timeoutMs: opts.timeoutMs })
        return { ok: true, status: 200, text: '摘要完成', latencyMs: 10 }
      },
    })

    const res = await service.chat({ channel: 'web', userId: 'owner', text: '测试重试配置' })
    expect(res.reply).toBe('已按配置重试上限调用')
    expect(seenToolOpts).toHaveLength(1)
    expect(seenToolOpts[0]!.maxRetries).toBe(10)
    expect(seenToolOpts[0]!.timeoutMs).toBeGreaterThanOrEqual(140_000)

    const summary = await service.summarizeForWechat('sys', 'user')
    expect(summary).toBe('摘要完成')
    expect(seenPlainOpts).toHaveLength(1)
    expect(seenPlainOpts[0]!.maxRetries).toBe(10)
    expect(seenPlainOpts[0]!.timeoutMs).toBeGreaterThanOrEqual(60_000)
    service.close()
  })

  it('supports full host operations and console management with L3 confirmation gates and sensitive file protection', async () => {
    const env = setup()
    // 准备一个可读的普通文本文件和一个敏感凭据文件
    writeFileSync(join(env.dir, 'note.txt'), 'line1\nsecret=SUPER_SECRET_VALUE_999\nline3\n')
    writeFileSync(join(env.dir, 'vault.key'), 'RAW_VAULT_KEY_NEVER_READ')

    expect(isSensitiveHostPath('/home/ghost/superagent/state/vault.key')).toBe(true)
    expect(isSensitiveHostPath('/home/ghost/.ssh/id_ed25519')).toBe(true)
    expect(isSensitiveHostPath('/home/ghost/superagent/state/cli-token')).toBe(true)
    expect(isSensitiveHostPath('/home/ghost/superagent/README.md')).toBe(false)

    const hostCmds: Array<{ file: string; args: string[] }> = []
    const hostOps = new HostOpsService({
      homeDir: env.dir,
      stateDir: env.dir,
      runner: async (file, args) => {
        hostCmds.push({ file, args })
        if (file === 'systemctl' && args.includes('status')) return { code: 0, out: 'active (running)' }
        if (file === 'podman' && args[0] === 'ps') return { code: 0, out: 'ID\tNAMES\tSTATUS\nabc\tsa-t1\tUp 5m' }
        return { code: 0, out: 'cmd ok SUPER_SECRET_VALUE_999' }
      },
    })

    const fakePi = {
      status: async () => ({ image: 'localhost/superagent-pi:1.6.0-dev20261114-125853', version: '1.6.0', base: 'localhost/superagent-dev:20261114-125853', images: [], package: 'pi', releases: [] }),
      startBuild: async (v: string) => ({ version: v, image: `localhost/superagent-pi:${v}`, state: 'running', startedAt: '', log: [] }),
      apply: async (image: string) => ({ image, version: '1.6.0', previous: 'localhost/superagent-pi:1.5.2' }),
      remove: async () => ({ ok: true }),
    } as any

    const fakeDevEnv = {
      status: async () => ({ image: 'localhost/superagent-pi:1.6.0-dev20261114-125853', base: 'localhost/superagent-dev:20261114-125853', packages: [], features: ['browser', 'dbserver'], devImages: [], available: { features: ['browser', 'dbserver', 'go', 'java'] } }),
      startRepack: async (devImage: string) => ({ tag: '20261114-125853', devImage, piImage: 'localhost/superagent-pi:1.6.0-dev20261114-125853', mode: 'repack', packages: [], features: ['browser', 'dbserver'], mirrors: true, state: 'running', startedAt: '', log: [] }),
      apply: async (image: string) => ({ image, previous: 'old' }),
      removeDevImage: async () => ({ ok: true }),
    } as any

    const service = new DirectorService({
      host: env.fake.host,
      options: env.options,
      ledger: env.ledger,
      events: env.events,
      store: env.store,
      redact: env.redact,
      hostOps,
      piVersions: fakePi,
      devEnv: fakeDevEnv,
    })

    const sess = env.store.getOrCreateSession('web', 'owner')
    const ctx = { session: sess, confirmHighRisk: true }

    // 1. L1 只读：宿主机文件读取自动脱敏且拒绝敏感凭据路径
    const okRead = await service.tools.run('host_ops', { action: 'host_read_file', params_json: JSON.stringify({ path: join(env.dir, 'note.txt') }) }, ctx)
    expect(okRead.ok).toBe(true)
    expect(okRead.output).toContain('[UNTRUSTED_DATA:')
    expect(okRead.output).toContain('***')
    expect(okRead.output).not.toContain('SUPER_SECRET_VALUE_999')

    const blockedRead = await service.tools.run('host_ops', { action: 'host_read_file', params_json: JSON.stringify({ path: join(env.dir, 'vault.key') }) }, ctx)
    expect(blockedRead.ok).toBe(false)
    expect(blockedRead.output).toContain('敏感凭据')

    // 2. L1 只读：Pi 版本、开发环境与全部设置查询
    const piSt = await service.tools.run('platform_query', { action: 'pi_status', params_json: '{}' }, ctx)
    expect(piSt.ok).toBe(true)
    expect(piSt.output).toContain('1.6.0-dev20261114-125853')

    const devSt = await service.tools.run('platform_query', { action: 'devenv_status', params_json: '{}' }, ctx)
    expect(devSt.ok).toBe(true)
    expect(devSt.output).toContain('dbserver')

    const repackRes = await service.tools.run('subsystem_action', { action: 'devenv_repack', params_json: JSON.stringify({ devImage: 'localhost/superagent-dev:20261114-125853' }) }, ctx)
    expect(repackRes.ok).toBe(true)
    expect(repackRes.output).toContain('极速封装')

    // 3. L3 宿主机命令执行必须经二次确认，批准后才执行并脱敏输出
    const cmdsBefore = hostCmds.length
    const execGated = await service.tools.run('host_ops', { action: 'host_exec', params_json: JSON.stringify({ command: 'uname -a' }) }, ctx)
    expect(execGated.ok).toBe(true)
    expect(execGated.pendingActionId).toBeTruthy()
    expect(hostCmds.length).toBe(cmdsBefore)

    const execApproved = await service.decidePendingAction(execGated.pendingActionId!, 'approve')
    expect(execApproved.ok).toBe(true)
    expect(hostCmds.length).toBe(cmdsBefore + 1)
    const approvedRecord = env.store.getPendingAction(execGated.pendingActionId!)
    expect(approvedRecord?.resultText).not.toContain('SUPER_SECRET_VALUE_999')

    // 4. L3 控制台设置变更（settings_update）经二次确认后落盘生效
    const setGated = await service.tools.run('high_risk_action', {
      action: 'settings_update',
      params_json: JSON.stringify({ section: 'director', patch: { maxRetries: 12 } }),
    }, ctx)
    expect(setGated.ok).toBe(true)
    expect(setGated.pendingActionId).toBeTruthy()
    expect(env.options.get().director.maxRetries).toBe(5)

    const setApproved = await service.decidePendingAction(setGated.pendingActionId!, 'approve')
    expect(setApproved.ok).toBe(true)
    expect(env.options.get().director.maxRetries).toBe(12)

    // 5. L3 宿主机服务控制（确认 params_json 里的 op/action 不会被路由键污染）
    const svcGated = await service.tools.run('host_ops', {
      action: 'service_control',
      params_json: JSON.stringify({ unit: 'flclash.service', op: 'restart' }),
    }, ctx)
    expect(svcGated.ok).toBe(true)
    expect(svcGated.pendingActionId).toBeTruthy()
    const svcApproved = await service.decidePendingAction(svcGated.pendingActionId!, 'approve')
    expect(svcApproved.ok).toBe(true)
    expect(hostCmds.some(c => c.file === 'systemctl' && c.args.includes('restart') && c.args.includes('flclash.service'))).toBe(true)

    service.close()
  })

  it('automatically wakes Director to run promised next steps on ticket completion (explicit onComplete and inferred promise)', async () => {
    const env = setup()
    env.options.updateWechat({ enabled: false, mode: 'ilink', routingMode: 'director', allowedUsers: ['wx_owner_1'] })
    env.options.updateFeishu({
      enabled: true, mode: 'ws', appId: 'cli_x', appSecret: 'sec_x', verificationToken: '', encryptKey: '',
      apiBase: 'https://open.feishu.cn', groupMode: 'mention', routingMode: 'director',
    })

    const sentFeishu: { to: string; text: string; replyTo?: string }[] = []
    const hostOps = new HostOpsService({
      homeDir: env.dir,
      runner: async () => ({ code: 0, out: 'deployed ok' }),
    })

    let phase: 'dispatch' | 'auto_explicit' | 'dispatch_implicit' | 'auto_implicit' = 'dispatch'
    let autoStep = 0
    let dispatched2 = false
    const service = new DirectorService({
      host: env.fake.host,
      options: env.options,
      ledger: env.ledger,
      events: env.events,
      store: env.store,
      redact: env.redact,
      hostOps,
      sendFeishu: async m => { sentFeishu.push(m) },
      callTool: async (): Promise<ToolModelResult> => {
        if (phase === 'dispatch') {
          phase = 'auto_explicit'
          return {
            ok: true, status: 200, text: '', latencyMs: 10,
            toolCalls: [{
              id: 'tc_disp_1',
              name: 'dispatch_ticket',
              arguments: {
                prompt: '修复订单接口并跑通单测',
                onComplete: '检查测试通过后执行宿主机部署脚本 ./deploy.sh',
              },
            }],
          }
        }
        if (phase === 'auto_explicit') {
          autoStep += 1
          if (autoStep === 1) {
            return { ok: true, status: 200, text: '已派发工单 t_new_1，完成后将自动执行下一步部署。', latencyMs: 10, toolCalls: [] }
          }
          if (autoStep === 2) {
            // 自动唤醒后立刻调用 host_ops(host_exec) 发起部署并触发 L3 确认短码
            return {
              ok: true, status: 200, text: '', latencyMs: 10,
              toolCalls: [{
                id: 'tc_deploy_1',
                name: 'host_ops',
                arguments: { action: 'host_exec', params_json: JSON.stringify({ command: './deploy.sh' }) },
              }],
            }
          }
          return { ok: true, status: 200, text: '工单 t_new_1 已完成，我已自动发起下一步部署（./deploy.sh），请回复「确认」执行。', latencyMs: 10, toolCalls: [] }
        }
        if (phase === 'dispatch_implicit') {
          if (!dispatched2) {
            dispatched2 = true
            return {
              ok: true, status: 200, text: '', latencyMs: 10,
              toolCalls: [{
                id: 'tc_disp_2',
                name: 'dispatch_ticket',
                arguments: { prompt: '打包前端资源' },
              }],
            }
          }
          phase = 'auto_implicit'
          return { ok: true, status: 200, text: '已派发打包工单 t_new_2，任务完成后我会立刻自动重启服务。', latencyMs: 10, toolCalls: [] }
        }
        return { ok: true, status: 200, text: '工单 t_new_2 已完工，已按承诺自动续接并推进重启服务。', latencyMs: 10, toolCalls: [] }
      },
    })

    const bridge = new DirectorBridge({
      director: service,
      options: env.options,
      host: env.fake.host,
      events: env.events,
      sendWechat: async m => { env.sentWechat.push(m) },
      sendFeishu: async m => { sentFeishu.push(m) },
      feishuRecipients: () => ['ou_owner'],
    })

    // 场景 1：显式通过 onComplete 登记续接 -> 工单完工自动唤醒、调用部署工具并主动推到飞书
    const disp = await service.chat({ channel: 'feishu', userId: 'ou_owner', text: '先修复订单接口，跑完后自动帮我部署' })
    expect(disp.reply).toContain('t_new_1')
    const pendingFws = env.store.listFollowups(disp.sessionId, true)
    expect(pendingFws).toHaveLength(1)
    expect(pendingFws[0]!.targetId).toBe('t_new_1')

    await bridge.notify({
      kind: 'ticket.ended',
      ticketId: 't_new_1',
      title: '修复订单接口并跑通单测',
      outcome: 'completed',
      summary: '所有单元测试通过，补丁已就绪。',
    })

    expect(env.store.listFollowups(disp.sessionId, true)).toHaveLength(0)
    expect(env.store.getFollowup(pendingFws[0]!.id)?.status).toBe('done')
    expect(env.store.listPendingActions(disp.sessionId, true)).toHaveLength(1)
    expect(sentFeishu).toHaveLength(1)
    expect(sentFeishu[0]!.text).toContain('已自动发起下一步部署')

    // 场景 2：模型忘记填 onComplete，但在回复中口头承诺「任务完成后我会立刻自动重启服务」-> 兜底自动唤醒
    phase = 'dispatch_implicit'
    await service.chat({ channel: 'feishu', userId: 'ou_owner', text: '打包前端，完成后自动重启服务' })
    expect(env.store.listFollowups(disp.sessionId, true)).toHaveLength(0)

    await bridge.notify({
      kind: 'ticket.ended',
      ticketId: 't_new_2',
      title: '打包前端资源',
      outcome: 'completed',
      summary: '前端构建成功。',
    })

    expect(sentFeishu).toHaveLength(2)
    expect(sentFeishu[1]!.text).toContain('自动续接')
    service.close()
  })

  it('allows Director to manage ANY platform configuration (full models CRUD, discover, channels/vault secrets, policy/roles) with recursive secret redaction', async () => {
    const env = setup()
    const boundFanqie: Array<{ bookId: string; fqBookId: string }> = []
    const fakeFanqie = {
      status: () => ({ ok: true, hasCookie: true }),
      boundTo: (id: string) => boundFanqie.find(b => b.bookId === id)?.fqBookId,
      list: () => [],
      remoteBooks: async () => [{ id: '7123456789012345', title: '测试书' }],
      bind: (bookId: string, fqBookId: string) => { boundFanqie.push({ bookId, fqBookId }) },
    } as any

    const service = new DirectorService({
      host: env.fake.host,
      options: env.options,
      ledger: env.ledger,
      events: env.events,
      store: env.store,
      redact: env.redact,
      fanqie: fakeFanqie,
    })

    const sess = env.store.getOrCreateSession('web', 'owner')
    const ctx = { session: sess, confirmHighRisk: true }

    const runSettingsUpdate = async (section: string, patch: Record<string, unknown>) => {
      const gated = await service.tools.run('high_risk_action', {
        action: 'settings_update',
        params_json: JSON.stringify({ section, patch }),
      }, ctx)
      expect(gated.ok).toBe(true)
      expect(gated.pendingActionId).toBeTruthy()
      const listed = service.listPendingActions(sess.id, true)
      const pendingView = listed.find(a => a.id === gated.pendingActionId)
      const approved = await service.decidePendingAction(gated.pendingActionId!, 'approve')
      return { gated, pendingView, approved }
    }

    // 1. model_discover 自动读取已保存服务商地址与协议，也支持探测新地址
    const discSaved = await service.tools.run('platform_query', {
      action: 'model_discover',
      params_json: JSON.stringify({ provider: 'default' }),
    }, ctx)
    expect(discSaved.ok).toBe(true)
    expect(discSaved.output).toContain('claude-sonnet-4')
    expect(env.fake.discoverCalls).toHaveLength(1)

    // 2. models 全量能力：新增服务商 + 设置 apiKey + 新增模型 + 一次性用 "provider/model" 切换 worker
    const { gated: mGated, pendingView: mView, approved: mOk } = await runSettingsUpdate('models', {
      providerUpserts: [{
        id: 'relay',
        name: '自建中转站',
        api: 'anthropic-messages',
        baseUrl: 'https://relay.example.com',
        apiKey: 'sk-relay-super-secret-9999',
        models: [{ id: 'claude-sonnet-4', label: 'Sonnet 4', reasoning: true, price: { input: 3, output: 15 } }],
      }],
      routing: { worker: 'relay/claude-sonnet-4', autoSelect: true },
    })
    expect(mOk.ok).toBe(true)
    // 确认摘要、待确认 API 视图与落库后的历史参数均不能泄露明文 apiKey
    expect(mGated.output).not.toContain('sk-relay-super-secret-9999')
    expect(JSON.stringify(mView?.args)).not.toContain('sk-relay-super-secret-9999')
    expect(JSON.stringify(env.store.getPendingAction(mGated.pendingActionId!)?.args)).not.toContain('sk-relay-super-secret-9999')
    const afterAdd = env.options.get().models
    expect(afterAdd.providers.find(p => p.id === 'relay')?.apiKey).toBe('sk-relay-super-secret-9999')
    expect(afterAdd.routing.worker).toEqual({ provider: 'relay', model: 'claude-sonnet-4' })
    expect(afterAdd.routing.autoSelect).toBe(true)

    // 3. models 顶层 modelUpserts（新增与更新模型）+ 保留原 apiKey + modelDeletes + clearApiKey
    const m2 = await runSettingsUpdate('models', {
      modelUpserts: [
        { provider: 'relay', id: 'claude-opus-4', label: 'Opus 4', maxTokens: 65536 },
        { ref: 'relay/claude-sonnet-4', maxTokens: 32768 },
      ],
      providerUpserts: [{ id: 'relay', name: '主力中转站' }],
    })
    expect(m2.approved.ok).toBe(true)
    const relay2 = env.options.get().models.providers.find(p => p.id === 'relay')!
    expect(relay2.name).toBe('主力中转站')
    expect(relay2.apiKey).toBe('sk-relay-super-secret-9999')
    expect(relay2.models.map(m => m.id)).toEqual(['claude-sonnet-4', 'claude-opus-4'])
    expect(relay2.models.find(m => m.id === 'claude-sonnet-4')?.maxTokens).toBe(32768)

    const m3 = await runSettingsUpdate('models', {
      modelDeletes: ['relay/claude-opus-4'],
      providerUpserts: [{ id: 'relay', clearApiKey: true }],
    })
    expect(m3.approved.ok).toBe(true)
    const relay3 = env.options.get().models.providers.find(p => p.id === 'relay')!
    expect(relay3.models.map(m => m.id)).toEqual(['claude-sonnet-4'])
    expect(relay3.apiKey).toBe('')

    // 4. director / goal / novel / web / collab / council 均支持 "provider/model" 简写与增量角色编辑
    expect((await runSettingsUpdate('director', { model: 'relay/claude-sonnet-4', maxRetries: 9 })).approved.ok).toBe(true)
    expect(env.options.get().director.model).toEqual({ provider: 'relay', model: 'claude-sonnet-4' })
    expect(env.options.get().director.maxRetries).toBe(9)

    expect((await runSettingsUpdate('goal', { judge: 'relay/claude-sonnet-4', maxRounds: 12 })).approved.ok).toBe(true)
    expect(env.options.get().goal.judge).toEqual({ provider: 'relay', model: 'claude-sonnet-4' })

    expect((await runSettingsUpdate('novel', { models: { writer: 'relay/claude-sonnet-4' } })).approved.ok).toBe(true)
    expect(env.options.get().novel.models.writer).toEqual({ provider: 'relay', model: 'claude-sonnet-4' })

    expect((await runSettingsUpdate('web', { exaKey: 'exa-secret-123', claudeModel: 'relay/claude-sonnet-4', geminiModel: 'default/deepseek-v4.1-flash' })).approved.ok).toBe(true)
    expect(env.options.get().web.exaKey).toBe('exa-secret-123')
    expect(env.options.get().web.claudeModel).toEqual({ provider: 'relay', model: 'claude-sonnet-4' })
    // 再次保存不传 exaKey 应保留旧 key，传 exaKeyClear: true 应清空
    expect((await runSettingsUpdate('web', { maxSearches: 60, exaKeySet: true })).approved.ok).toBe(true)
    expect(env.options.get().web.exaKey).toBe('exa-secret-123')
    expect((await runSettingsUpdate('web', { exaKeyClear: true })).approved.ok).toBe(true)
    expect(env.options.get().web.exaKey).toBe('')

    expect((await runSettingsUpdate('collab', {
      roleUpserts: [{ id: 'sec-auditor', name: '安全审计', description: '代码安全复核', access: 'read', enabled: true, model: 'relay/claude-sonnet-4', prompt: '重点查鉴权' }],
    })).approved.ok).toBe(true)
    expect(env.options.get().collab.roles.find(r => r.id === 'sec-auditor')?.model).toEqual({ provider: 'relay', model: 'claude-sonnet-4' })

    expect((await runSettingsUpdate('council', {
      moderator: 'relay/claude-sonnet-4',
      roleUpserts: [{ id: 'sec-seat', name: '安全架构师', persona: '评估风险边界', enabled: true, model: 'default/deepseek-v4.1-flash' }],
    })).approved.ok).toBe(true)
    expect(env.options.get().council.moderator).toEqual({ provider: 'relay', model: 'claude-sonnet-4' })
    expect(env.options.get().council.roles.find(r => r.id === 'sec-seat')?.model).toEqual({ provider: 'default', model: 'deepseek-v4.1-flash' })

    // 5. policy 增量规则与操作员管理 + 飞书/微信/邮箱/GitHub 密钥安全写入与只读标志忽略 + SSH 策略
    expect((await runSettingsUpdate('policy', {
      acceptMode: 'observe',
      ruleUpserts: [{ id: 'r_prod', name: '生产保护', enabled: true, instruction: '禁止直接删库' }],
      feishuOperatorUpserts: [{ id: 'ou_boss', name: '主人' }],
    })).approved.ok).toBe(true)
    expect(env.fake.host.getPolicy().rules.map(r => r.id)).toEqual(['r_prod'])
    expect(env.fake.host.getPolicy().feishuOperators).toEqual([{ id: 'ou_boss', name: '主人' }])

    expect((await runSettingsUpdate('feishu', {
      enabled: true, mode: 'ws', appId: 'cli_fs1', appSecret: 'fs_sec_111', appSecretSet: false,
    })).approved.ok).toBe(true)
    expect(env.options.get().feishu.appSecret).toBe('fs_sec_111')
    // 二次更新不传 appSecret 时保留原密钥
    expect((await runSettingsUpdate('feishu', { routingMode: 'director', appSecretSet: true })).approved.ok).toBe(true)
    expect(env.options.get().feishu.appSecret).toBe('fs_sec_111')

    expect((await runSettingsUpdate('wechat', {
      allowedUsers: ['wx_owner_1', 'wx_owner_2'],
      bridgeToken: 'wx_tok_222',
    })).approved.ok).toBe(true)
    expect(env.options.get().wechat.bridgeToken).toBe('wx_tok_222')
    expect(env.fake.getWechatAllowedUsers()).toEqual(['wx_owner_1', 'wx_owner_2'])

    const emailRes = await runSettingsUpdate('email', {
      enabled: true, preset: 'gmail', address: 'bot@gmail.com',
      allowedSenders: ['Boss@Example.com'], password: 'app_pwd_secret_333',
    })
    expect(emailRes.approved.ok).toBe(true)
    expect(emailRes.gated.output).not.toContain('app_pwd_secret_333')
    expect(env.fake.getEmailPassword()).toBe('app_pwd_secret_333')
    expect(env.fake.getEmailAllowedSenders()).toEqual(['boss@example.com'])
    // 仅轮换邮箱密码时触发重启邮箱轮询
    const emailPwdOnly = await runSettingsUpdate('email', { password: 'app_pwd_rotated_444' })
    expect(emailPwdOnly.approved.ok).toBe(true)
    expect(env.fake.getEmailPassword()).toBe('app_pwd_rotated_444')
    expect(env.fake.getEmailRestarts()).toBe(1)

    const ghRes = await runSettingsUpdate('github', { enabled: true, repos: ['org/repo'], token: 'ghp_new_secret_555' })
    expect(ghRes.approved.ok).toBe(true)
    expect(ghRes.gated.output).not.toContain('ghp_new_secret_555')
    expect(env.fake.getGithubToken()).toBe('ghp_new_secret_555')

    expect((await runSettingsUpdate('ssh', { allTickets: false })).approved.ok).toBe(true)
    expect(env.options.get().ssh.allTickets).toBe(false)

    // settings_get 返回包含 tokenSet / passwordSet 的完整配置视图
    const getEmail = await service.tools.run('platform_query', { action: 'settings_get', params_json: JSON.stringify({ section: 'email' }) }, ctx)
    expect(getEmail.ok).toBe(true)
    expect(getEmail.output).toContain('"passwordSet": true')
    const getGh = await service.tools.run('platform_query', { action: 'settings_get', params_json: JSON.stringify({ section: 'github' }) }, ctx)
    expect(getGh.ok).toBe(true)
    expect(getGh.output).toContain('"tokenSet": true')

    // 6. 番茄绑定 + 微信扫码解绑（L3）
    const fqBind = await service.tools.run('subsystem_action', { action: 'fanqie_bind', params_json: JSON.stringify({ bookId: 'b_demo', fqBookId: '7123456789012345' }) }, ctx)
    expect(fqBind.ok).toBe(true)
    expect(boundFanqie).toEqual([{ bookId: 'b_demo', fqBookId: '7123456789012345' }])

    const wxLogoutGated = await service.tools.run('high_risk_action', { action: 'wechat_qr_logout', params_json: '{}' }, ctx)
    expect(wxLogoutGated.ok).toBe(true)
    expect(wxLogoutGated.pendingActionId).toBeTruthy()
    expect(env.fake.isWechatLoggedOut()).toBe(false)
    expect((await service.decidePendingAction(wxLogoutGated.pendingActionId!, 'approve')).ok).toBe(true)
    expect(env.fake.isWechatLoggedOut()).toBe(true)

    // 7. providerDeletes：先切回 default，再删除 relay 服务商
    expect((await runSettingsUpdate('director', { model: null })).approved.ok).toBe(true)
    expect((await runSettingsUpdate('goal', { judge: null })).approved.ok).toBe(true)
    expect((await runSettingsUpdate('novel', { models: { writer: null } })).approved.ok).toBe(true)
    expect((await runSettingsUpdate('council', { moderator: null })).approved.ok).toBe(true)
    expect((await runSettingsUpdate('models', {
      routing: { worker: 'default/deepseek-v4.1-flash' },
      providerDeletes: ['relay'],
    })).approved.ok).toBe(true)
    expect(env.options.get().models.providers.map(p => p.id)).toEqual(['default'])

    service.close()
  })

  it('forwards configured director.stepTimeoutSec and firstByteTimeoutSec (including 0 to disable) to callTool', async () => {
    const env = setup()
    env.options.update('director', { ...env.options.get().director, stepTimeoutSec: 1800, firstByteTimeoutSec: 1500 })

    const seen: Array<{ timeoutMs: number; firstByteTimeoutMs?: number }> = []
    const service = new DirectorService({
      host: env.fake.host,
      options: env.options,
      ledger: env.ledger,
      events: env.events,
      store: env.store,
      redact: env.redact,
      callTool: async (_target, _req, opts) => {
        seen.push({ timeoutMs: opts.timeoutMs, firstByteTimeoutMs: opts.firstByteTimeoutMs })
        return { ok: true, status: 200, text: 'ok', latencyMs: 5, toolCalls: [] }
      },
    })

    await service.chat({ channel: 'web', userId: 'owner', text: '长推理测试1' })
    expect(seen[0]).toEqual({ timeoutMs: 1_800_000, firstByteTimeoutMs: 1_500_000 })

    env.options.update('director', { ...env.options.get().director, stepTimeoutSec: 2400, firstByteTimeoutSec: 0 })
    await service.chat({ channel: 'web', userId: 'owner', text: '长推理测试2' })
    expect(seen[1]).toEqual({ timeoutMs: 2_400_000, firstByteTimeoutMs: 0 })
    service.close()
  })

  it('uses nodeHttpFetch cleanly for >240s long-timeout streaming SSE tool responses', async () => {
    const sseBody = [
      'data: {"choices":[{"delta":{"content":"长推理思考完毕，"}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_long_1","function":{"name":"platform_query","arguments":"{\\"action\\":\\"platform_overview\\",\\"params_json\\":\\"{}\\"}"}}]}}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":50,"completion_tokens":12}}\n\n',
      'data: [DONE]\n\n',
    ].join('')
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
      res.end(sseBody)
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()))
    try {
      const addr = server.address() as { port: number }
      const res = await callToolModel(
        { api: 'openai-completions', baseUrl: `http://127.0.0.1:${addr.port}/v1`, apiKey: 'sk-test' },
        {
          model: 'reasoning-model',
          system: 'sys',
          messages: [{ role: 'user', content: 'run' }],
          tools: [{ name: 'platform_query', description: 'q', parameters: { type: 'object', properties: {} } }],
          maxTokens: 1024,
        },
        { timeoutMs: 300_000, stream: true, firstByteTimeoutMs: 0, maxRetries: 0 },
      )
      expect(res.ok).toBe(true)
      expect(res.text).toBe('长推理思考完毕，')
      expect(res.toolCalls).toEqual([{
        id: 'call_long_1',
        name: 'platform_query',
        arguments: { action: 'platform_overview', params_json: '{}' },
      }])
      expect(res.usage?.completion_tokens).toBe(12)
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  })

  describe('director reliability & anti-hallucination guardrails', () => {
    it('flattenToolHistory flattens tool_use and tool_result blocks cleanly when tools are omitted', async () => {
      const flattened = flattenToolHistory([
        { role: 'user', content: '查概览' },
        {
          role: 'assistant',
          content: '我先查一下',
          toolCalls: [{ id: 'c1', name: 'platform_query', arguments: { action: 'platform_overview' } }],
        },
        { role: 'tool', toolCallId: 'c1', name: 'platform_query', content: '{"ok":true,"tickets":1}' },
      ])

      expect(flattened).toHaveLength(3)
      expect(flattened.every(m => m.role === 'user' || m.role === 'assistant')).toBe(true)
      expect(flattened[1]!.content).toContain('[已调用工具]')
      expect(flattened[1]!.content).toContain('platform_query')
      expect(flattened[2]!.role).toBe('user')
      expect(flattened[2]!.content).toContain('[工具返回 platform_query（成功）]')

      let capturedOpenAi: any
      const fakeFetch: typeof fetch = async (_url, init) => {
        capturedOpenAi = JSON.parse(String(init?.body))
        return new Response(JSON.stringify({
          choices: [{ message: { role: 'assistant', content: '汇总完成' } }],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      const res = await callToolModel(
        { api: 'openai-completions', baseUrl: 'https://api.example.com/v1', apiKey: 'sk-test' },
        {
          model: 'm1',
          system: 'sys',
          messages: [
            { role: 'user', content: 'hi' },
            { role: 'assistant', content: '', toolCalls: [{ id: 'tc1', name: 'platform_query', arguments: { action: 'platform_overview' } }] },
            { role: 'tool', toolCallId: 'tc1', name: 'platform_query', content: '{"ok":true}' },
          ],
          tools: [],
          maxTokens: 256,
        },
        { timeoutMs: 5000, fetch: fakeFetch },
      )
      expect(res.ok).toBe(true)
      expect(capturedOpenAi.tools).toBeUndefined()
      expect(capturedOpenAi.messages.some((m: any) => m.role === 'tool' || m.tool_calls)).toBe(false)
    })

    it('injects closing instruction on exhausted maxToolSteps and sanitizes unmounted-tool / manage_task hallucinations', async () => {
      const env = setup()
      env.options.update('director', { ...env.options.get().director, maxToolSteps: 1 })
      const requests: ToolModelRequest[] = []
      let step = 0
      const service = new DirectorService({
        host: env.fake.host,
        options: env.options,
        ledger: env.ledger,
        events: env.events,
        store: env.store,
        redact: env.redact,
        callTool: async (_target, req) => {
          requests.push(req)
          step += 1
          if (step === 1) {
            return {
              ok: true,
              status: 200,
              latencyMs: 10,
              text: '',
              toolCalls: [
                { id: 'c_ov', name: 'platform_query', arguments: { action: 'platform_overview', params_json: '{}' } },
              ],
            }
          }
          // 模拟收口轮在 tools: [] 情况下仍幻觉声称“工具未挂载/仅剩 manage_task”
          return {
            ok: true,
            status: 200,
            latencyMs: 10,
            text: '抱歉，当前工具未挂载，仅剩 manage_task 可用（unknown tool）。',
            toolCalls: [],
          }
        },
      })

      const res = await service.chat({ channel: 'web', userId: 'owner', text: '看看平台概览' })
      expect(requests).toHaveLength(2)
      expect(requests[1]!.tools).toEqual([])
      const lastMsg = requests[1]!.messages[requests[1]!.messages.length - 1]
      expect(lastMsg?.role).toBe('user')
      expect(lastMsg?.content).toContain('[系统收口提示]')
      expect(lastMsg?.content).toContain('主动关闭工具调用')
      expect(res.reply).not.toMatch(/工具未挂载|manage_task|unknown\s+tool/i)
      expect(res.reply).toContain('platform_query')
      expect(env.events.recent(20).some(e => e.kind === 'director.reply_sanitized')).toBe(true)
      service.close()
    })

    it('warns on 2nd identical read-only poll and short-circuits 3rd+ poll while resetting after write actions', async () => {
      const env = setup()
      env.options.update('director', { ...env.options.get().director, maxToolSteps: 8 })
      let overviewCalls = 0
      const origOverview = env.fake.host.overview
      env.fake.host.overview = () => {
        overviewCalls += 1
        return origOverview()
      }

      const seenToolOutputs: string[] = []
      let turn = 0
      const service = new DirectorService({
        host: env.fake.host,
        options: env.options,
        ledger: env.ledger,
        events: env.events,
        store: env.store,
        redact: env.redact,
        callTool: async (_target, req) => {
          turn += 1
          const latestTool = [...req.messages].reverse().find(m => m.role === 'tool')
          if (latestTool) seenToolOutputs.push(latestTool.content)

          if (turn <= 3) {
            return {
              ok: true,
              status: 200,
              latencyMs: 5,
              text: '',
              toolCalls: [
                { id: `ov_${turn}`, name: 'platform_query', arguments: { action: 'platform_overview', params_json: '{}' } },
              ],
            }
          }
          if (turn === 4) {
            // 穿插一次写操作后应清空只读防重计数
            return {
              ok: true,
              status: 200,
              latencyMs: 5,
              text: '',
              toolCalls: [
                { id: 'w_1', name: 'dispatch_ticket', arguments: { prompt: '执行一次状态检查工单' } },
              ],
            }
          }
          if (turn === 5) {
            return {
              ok: true,
              status: 200,
              latencyMs: 5,
              text: '',
              toolCalls: [
                { id: 'ov_after_write', name: 'platform_query', arguments: { action: 'platform_overview', params_json: '{}' } },
              ],
            }
          }
          return { ok: true, status: 200, latencyMs: 5, text: '巡检完成，共执行真实概览查询。', toolCalls: [] }
        },
      })

      const res = await service.chat({ channel: 'web', userId: 'owner', text: '测试防空轮询' })
      expect(res.reply).toContain('巡检完成')
      // 开场态势快照 1 次 + 第1、2轮真实执行 + 第3轮被短路拦截 + 写操作清空后第5轮重新执行 1 次 => 总计 4 次
      expect(overviewCalls).toBe(4)
      expect(seenToolOutputs[1]).toContain('防空轮询提示')
      expect(seenToolOutputs[2]).toContain('已拦截重复空轮询')
      service.close()
    })

    it('findSafeCompactCutIndex backs up before assistant(toolCalls) so tool pairs are never torn during compaction', () => {
      const base = { sessionId: 's1', archived: false, createdAt: '2026-11-24T00:00:00.000Z' }
      const messages = [
        { ...base, id: 1, role: 'user' as const, content: 'q0' },
        { ...base, id: 2, role: 'assistant' as const, content: 'a0' },
        { ...base, id: 3, role: 'user' as const, content: 'q0_2' },
        { ...base, id: 4, role: 'assistant' as const, content: 'a0_2' },
        { ...base, id: 5, role: 'user' as const, content: 'q0_3' },
        { ...base, id: 6, role: 'assistant' as const, content: 'a0_3' },
        { ...base, id: 7, role: 'user' as const, content: 'q1' },
        { ...base, id: 8, role: 'assistant' as const, content: '', toolCalls: [{ id: 'tc1', name: 'platform_query', arguments: {} }] },
        { ...base, id: 9, role: 'tool' as const, toolCallId: 'tc1', toolName: 'platform_query', content: '{"ok":1}' },
        { ...base, id: 10, role: 'tool' as const, toolCallId: 'tc2', toolName: 'platform_query', content: '{"ok":2}' },
        { ...base, id: 11, role: 'assistant' as const, content: 'answer1' },
        { ...base, id: 12, role: 'user' as const, content: 'q2' },
      ]

      // len=12, keepTail=4 => 初步 cutIndex=8（正好停在 role='tool' 上），必须回退到 index=6（保留 index=7 的 user 与配对 assistant(toolCalls)）
      expect(findSafeCompactCutIndex(messages, 4)).toBe(6)
      // len=12, keepTail=3 => 初步 cutIndex=9（也在 tool 上），同样必须回退到 index=6
      expect(findSafeCompactCutIndex(messages, 3)).toBe(6)
      // len=12, keepTail=1 => 初步 cutIndex=11（role='user' 且前一条非 toolCalls），无需回退
      expect(findSafeCompactCutIndex(messages, 1)).toBe(11)
      // 不足最小归档阈值（<=4）时返回 -1
      expect(findSafeCompactCutIndex(messages.slice(0, 6), 4)).toBe(-1)
    })

    it('prioritizes cross-provider models in resolveFallbackModel before same-provider alternatives', async () => {
      const env = setup()
      const baseModels = env.options.get().models
      const templateProvider = baseModels.providers[0]!
      const templateModel = templateProvider.models[0]!
      env.options.update('models', {
        ...baseModels,
        providers: [
          {
            ...templateProvider,
            id: 'primary-gw',
            name: 'Primary GW',
            baseUrl: 'https://primary-gw.example/v1',
            apiKey: 'sk-primary',
            enabled: true,
            models: [
              { ...templateModel, id: 'p-main', autoPick: true },
              { ...templateModel, id: 'p-same-backup', autoPick: true },
            ],
          },
          {
            ...templateProvider,
            id: 'secondary-direct',
            name: 'Secondary Direct',
            baseUrl: 'https://secondary-direct.example/v1',
            apiKey: 'sk-secondary',
            enabled: true,
            models: [
              { ...templateModel, id: 's-cross-backup', autoPick: true },
            ],
          },
        ],
        routing: {
          ...baseModels.routing,
          worker: { provider: 'primary-gw', model: 'p-main' },
          assessor: { ...baseModels.routing.assessor, provider: 'primary-gw', model: 'p-main' },
        },
      })
      env.options.update('director', {
        ...env.options.get().director,
        model: { provider: 'primary-gw', model: 'p-main' },
        maxRetries: 0,
      })

      const triedTargets: Array<{ baseUrl: string; model: string }> = []
      const service = new DirectorService({
        host: env.fake.host,
        options: env.options,
        ledger: env.ledger,
        events: env.events,
        store: env.store,
        redact: env.redact,
        callTool: async (target, req) => {
          triedTargets.push({ baseUrl: target.baseUrl, model: req.model })
          if (req.model === 'p-main') {
            return { ok: false, status: 503, text: '', error: 'Upstream gateway TLS disconnected', latencyMs: 5, toolCalls: [] }
          }
          return { ok: true, status: 200, text: '已自动切换至跨服务商备援模型完成回复。', latencyMs: 5, toolCalls: [] }
        },
      })

      const res = await service.chat({ channel: 'web', userId: 'owner', text: '测试跨服务商优先备援' })
      expect(res.reply).toContain('跨服务商备援模型')
      expect(triedTargets).toEqual([
        { baseUrl: 'https://primary-gw.example/v1', model: 'p-main' },
        { baseUrl: 'https://secondary-direct.example/v1', model: 's-cross-backup' },
      ])
      service.close()
    })

    it('supports instruction alias + allowShorten on novel_edit_chapter and exposes novel_mark_read tool', async () => {
      const env = setup()
      const editCalls: Array<{ bookId: string; n: number; note: string; opts?: { allowShorten?: boolean } }> = []
      const markReadCalls: Array<{ bookId: string; n: number }> = []
      const fakeNovels = {
        editChapter: (bookId: string, n: number, note: string, opts?: { allowShorten?: boolean }) => {
          editCalls.push({ bookId, n, note, opts })
          return { id: 'e_1', n, status: 'running', note, costUsd: 0, createdAt: '2026-11-24T00:00:00Z', updatedAt: '2026-11-24T00:00:00Z' }
        },
        markRead: (bookId: string, n: number) => {
          markReadCalls.push({ bookId, n })
        },
      } as unknown as NovelService

      let turn = 0
      const toolOutputs: string[] = []
      const service = new DirectorService({
        host: env.fake.host,
        options: env.options,
        ledger: env.ledger,
        events: env.events,
        store: env.store,
        redact: env.redact,
        novels: fakeNovels,
        callTool: async (_target, req) => {
          turn += 1
          for (const m of req.messages) {
            if (m.role === 'tool') toolOutputs.push(m.content)
          }
          if (turn === 1) {
            return {
              ok: true,
              status: 200,
              latencyMs: 5,
              text: '',
              toolCalls: [
                {
                  id: 'n_edit',
                  name: 'subsystem_action',
                  arguments: {
                    action: 'novel_edit_chapter',
                    params_json: JSON.stringify({ bookId: 'b_novel_1', chapter: 12, instruction: '删除重复段落', allowShorten: true }),
                  },
                },
                {
                  id: 'n_read',
                  name: 'subsystem_action',
                  arguments: {
                    action: 'novel_mark_read',
                    params_json: JSON.stringify({ bookId: 'b_novel_1', chapter: 12 }),
                  },
                },
              ],
            }
          }
          return { ok: true, status: 200, latencyMs: 5, text: '已触发精修并标记已阅。', toolCalls: [] }
        },
      })

      const res = await service.chat({ channel: 'web', userId: 'owner', text: '精修第12章并标记已阅' })
      expect(res.reply).toContain('已触发精修')
      expect(editCalls).toEqual([{ bookId: 'b_novel_1', n: 12, note: '删除重复段落', opts: { allowShorten: true } }])
      expect(markReadCalls).toEqual([{ bookId: 'b_novel_1', n: 12 }])
      expect(toolOutputs.some(t => t.includes('请勿在本轮连续轮询 novel_chapter'))).toBe(true)
      expect(toolOutputs.some(t => t.includes('已标记为已阅'))).toBe(true)
      service.close()
    })

    it('treats Upstream response aborted as retryable and caps exponential backoff at 15s base', () => {
      expect(isRetryableNetworkError(new Error('Upstream response aborted'))).toBe(true)
      expect(isRetryableNetworkError(new Error('Client network socket disconnected before secure TLS connection was established'))).toBe(true)
      const ms = retryBackoffMs(10, 1000)
      expect(ms).toBeGreaterThanOrEqual(Math.round(15_000 * 0.85))
      expect(ms).toBeLessThanOrEqual(Math.round(15_000 * 1.15))
    })

    it('computeDirectorContextBudget aligns to 80% of 1M/131k models by default and enforces manual caps & 95% ceiling', () => {
      const budget1M = computeDirectorContextBudget(
        { contextWindow: 1_000_000, maxTokens: 131_072 },
        { contextWindowPercent: 80, maxContextTokens: 0, maxOutputTokens: 0 },
      )
      expect(budget1M.modelContextWindow).toBe(1_000_000)
      expect(budget1M.contextWindowPercent).toBe(80)
      expect(budget1M.effectiveContextTokens).toBe(800_000)
      expect(budget1M.effectiveOutputTokens).toBe(104_857)
      expect(budget1M.maxHistoryMessages).toBe(600)
      expect(budget1M.toolOutputLiveChars).toBe(96_000)
      expect(budget1M.toolOutputHistoryChars).toBe(32_000)
      expect(budget1M.compactTriggerTokens).toBe(680_000)
      expect(budget1M.compactKeepTokens).toBe(320_000)
      expect(budget1M.summaryMaxChars).toBe(8_000)
      expect(budget1M.summaryMaxTokens).toBe(4_000)

      const budget64k = computeDirectorContextBudget(
        { contextWindow: 64_000, maxTokens: 4_096 },
        { contextWindowPercent: 80, maxContextTokens: 0, maxOutputTokens: 0 },
      )
      expect(budget64k.effectiveContextTokens).toBe(51_200)
      expect(budget64k.effectiveOutputTokens).toBe(3_276)

      // 手动超配会被限制到模型窗口的 95%，且输出受剩余余量（headroom = 50_000）保护
      const capped = computeDirectorContextBudget(
        { contextWindow: 1_000_000, maxTokens: 131_072 },
        { contextWindowPercent: 80, maxContextTokens: 999_999, maxOutputTokens: 100_000 },
      )
      expect(capped.effectiveContextTokens).toBe(950_000)
      expect(capped.effectiveOutputTokens).toBe(50_000)
      expect(estimateTextTokens('你好ab')).toBe(3)
    })

    it('buildConversationWindow trims by token budget without splitting assistant(toolCalls) and tool pairs', () => {
      const base = { sessionId: 's_tok', archived: false, createdAt: '2026-11-24T00:00:00.000Z' }
      const messages = [
        { ...base, id: 1, role: 'user' as const, content: '早期问题' },
        { ...base, id: 2, role: 'assistant' as const, content: '', toolCalls: [{ id: 'old_tc', name: 'platform_query', arguments: {} }] },
        { ...base, id: 3, role: 'tool' as const, toolCallId: 'old_tc', toolName: 'platform_query', content: '甲'.repeat(15_000) },
        { ...base, id: 4, role: 'user' as const, content: '最近问题1' },
        { ...base, id: 5, role: 'assistant' as const, content: '', toolCalls: [{ id: 'new_tc', name: 'platform_query', arguments: {} }] },
        { ...base, id: 6, role: 'tool' as const, toolCallId: 'new_tc', toolName: 'platform_query', content: '乙'.repeat(6_000) },
        { ...base, id: 7, role: 'user' as const, content: '最新追问' },
      ]

      // 预算足够容纳 最近问题1 + new_tc/tool(不超 10_000 截断) + 最新追问，但放不下早期 15k 的 old_tc 组
      const win = buildConversationWindow(messages, { maxItems: 50, maxTokens: 8_000, maxToolOutputChars: 10_000 })
      expect(win[0]?.role).toBe('user')
      expect(win[0]?.content).toBe('最近问题1')
      expect(win.map(m => m.role)).toEqual(['user', 'assistant', 'tool', 'user'])
      const toolMsg = win[2]!
      expect(toolMsg.role === 'tool' ? toolMsg.content.length : 0).toBe(6_000)
    })

    it('forwards dynamic effectiveOutputTokens and expanded tool output cap to callTool and /api/director/status', async () => {
      const env = setup()
      const wsBigDir = join(env.dir, 'workspaces', 't_alpha', 'output')
      const bigText = `${`${'大数据块0123456789'.repeat(24)}\n`.repeat(100)}` // ~33,700 字（100 行，超过旧 12,000 字截断但未触及行上限）
      writeFileSync(join(wsBigDir, 'big.log'), bigText)

      const baseModels = env.options.get().models
      const p0 = baseModels.providers[0]!
      const m0 = p0.models[0]!
      env.options.update('models', {
        ...baseModels,
        providers: [{
          ...p0,
          id: 'gw1m',
          enabled: true,
          models: [{ ...m0, id: 'm1m', contextWindow: 1_000_000, maxTokens: 131_072, autoPick: true }],
        }],
        routing: {
          ...baseModels.routing,
          worker: { provider: 'gw1m', model: 'm1m' },
          assessor: { ...baseModels.routing.assessor, provider: 'gw1m', model: 'm1m' },
        },
      })
      env.options.update('director', {
        ...env.options.get().director,
        model: { provider: 'gw1m', model: 'm1m' },
        contextWindowPercent: 80,
        maxContextTokens: 0,
        maxOutputTokens: 0,
      })

      const seenMaxTokens: number[] = []
      const seenToolOutputs: string[] = []
      let turn = 0
      const service = new DirectorService({
        host: env.fake.host,
        options: env.options,
        ledger: env.ledger,
        events: env.events,
        store: env.store,
        redact: env.redact,
        callTool: async (_target, req) => {
          turn += 1
          seenMaxTokens.push(req.maxTokens)
          for (const m of req.messages) {
            if (m.role === 'tool') seenToolOutputs.push(m.content)
          }
          if (turn === 1) {
            return {
              ok: true,
              status: 200,
              latencyMs: 5,
              text: '',
              toolCalls: [
                {
                  id: 'read_big',
                  name: 'platform_query',
                  arguments: { action: 'ticket_read_file', params_json: JSON.stringify({ ticketId: 't_alpha', path: 'output/big.log', maxLines: 2000 }) },
                },
              ],
            }
          }
          return { ok: true, status: 200, latencyMs: 5, text: '已完整读取大日志。', toolCalls: [] }
        },
      })

      const res = await service.chat({ channel: 'web', userId: 'owner', text: '读取 t_alpha/output/big.log 全文' })
      expect(res.reply).toContain('已完整读取大日志')
      expect(seenMaxTokens).toEqual([104_857, 104_857])
      expect(seenToolOutputs[0]?.length).toBeGreaterThan(30_000)
      expect(seenToolOutputs[0]).not.toContain('内容超过 12000 字上限已截断')

      const st = service.status()
      expect(st.modelContextWindow).toBe(1_000_000)
      expect(st.contextWindowPercent).toBe(80)
      expect(st.effectiveContextTokens).toBe(800_000)
      expect(st.effectiveOutputTokens).toBe(104_857)
      service.close()
    })
  })
})
