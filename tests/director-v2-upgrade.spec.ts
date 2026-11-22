/**
 * 总控助手（Director）V2.4 能力全面升级回归测试：
 * 1. `dispatch_ticket` 正确透传 `projectMode:'worktree'` 与单机多执行器 `runnerId/scriptId/scriptParams_json`；
 * 2. `platform_query(ticket_receipt)` 一键返回结构化交付回执与任务约定；
 * 3. 多只读工具并发加速执行，保持结果顺序与审计完整；
 * 4. 主总控模型上游故障时自动切换备选已启用模型并完成回复；
 * 5. 新增零成本快捷口令 `/计划`、`/帮助`，以及系统提示词实时态势快照预注入。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OptionsStore, defaultOptions } from '../src/admin/options.ts'
import { DirectorService } from '../src/director/service.ts'
import { DirectorStore } from '../src/director/store.ts'
import { EventLog } from '../src/ledger/events.ts'
import { Ledger } from '../src/ledger/ledger.ts'
import { PluginRegistry } from '../src/plugins/registry.ts'
import { ContractStore } from '../src/contracts/store.ts'
import { GoalService, resolveGoal } from '../src/goal/service.ts'
import type { AdminHost } from '../src/admin/host.ts'

const dirs: string[] = []
function tempDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(d)
  return d
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function makeDeps() {
  const root = tempDir('sa-dir-v24-')
  const db = new DatabaseSync(':memory:')
  const ledger = new Ledger(db)
  const events = new EventLog(db)
  const store = new DirectorStore(db)
  const contracts = new ContractStore(db)
  const plugins = new PluginRegistry({ db })
  const optsDef = defaultOptions({})
  optsDef.models.providers = [
    {
      id: 'p1',
      name: 'Provider1',
      api: 'openai-completions',
      baseUrl: 'https://example.invalid/v1',
      apiKey: 'sk-test-1',
      sessionHeader: '',
      enabled: true,
      models: [
        { id: 'fast-model', label: 'Fast', description: '', reasoning: false, vision: false, contextWindow: 64000, maxTokens: 4096, autoPick: true, price: { input: 0, cacheRead: 0, output: 0 } },
        { id: 'backup-model', label: 'Backup', description: '', reasoning: true, vision: false, contextWindow: 64000, maxTokens: 4096, autoPick: true, price: { input: 0, cacheRead: 0, output: 0 } },
      ],
    },
  ]
  optsDef.models.routing.worker = { provider: 'p1', model: 'backup-model' }
  optsDef.models.routing.assessor = { ...optsDef.models.routing.assessor, provider: 'p1', model: 'fast-model' }
  optsDef.director.enabled = true
  optsDef.director.model = { provider: 'p1', model: 'fast-model' }
  optsDef.director.maxRetries = 0
  const options = new OptionsStore(join(root, 'options.json'), optsDef)

  const createTicket = vi.fn(async () => ({
    ticketId: 't_dispatched_1',
    triggerId: 'trg_1',
    threadId: 'th_1',
    threadKey: 'cli:th_1',
    decision: 'accept',
  }))

  const goals = new GoalService({
    db,
    ticket: () => ({ triggerId: 'trg_1', ended: true, waitsForPerson: false, undelivered: 0 }),
    spend: () => 0,
    settings: () => ({ maxRounds: 5, maxUsd: 5, maxHours: 2, commandTimeoutSec: 30, judge: null }),
    run: async () => ({ command: 'ok', code: 0, ms: 5, tail: 'ok' }),
    judge: async () => ({ ok: true, verdict: { met: true, evidence: ['ok'], missing: [], summary: 'ok' } }),
    report: () => undefined,
  })
  goals.set('t_r1', resolveGoal({ text: '核对销售周报', criteria: ['按付款日期统计'] }, { maxRounds: 5, maxUsd: 5, maxHours: 2 }))
  goals.recordEvidence('t_r1', { kind: 'data', runId: 'r1', artifactVersion: 'v1', passed: true, summary: '2 笔，总额 350.75' })
  contracts.ensureDefault('ticket', 't_r1', '核对销售周报', { criteria: ['按付款日期统计'] })

  const host = {
    overview: () => ({
      paused: false,
      acceptMode: 'auto',
      slots: { used: 1, max: 4, reservedForPerson: 1 },
      tickets: { open: 1, running: 1, needsPerson: 0, endedToday: 2 },
      attentionTickets: [],
      host: { load1: 0.4, cpuCount: 4, memUsedPct: 35, diskFreeGb: 100 },
      upstream: { ok: true, model: 'fast-model', provider: 'Provider1' },
    }),
    listTickets: () => ({
      total: 1,
      items: [{ id: 't_r1', title: '核对销售周报', status: 'ended', stage: 'completed', needsPerson: false, outcome: 'completed', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), costUsd: 0 }],
    }),
    ticket: (id: string) => id === 't_r1' ? {
      id: 't_r1',
      title: '核对销售周报',
      status: 'ended',
      stage: 'completed',
      needsPerson: false,
      outcome: 'completed',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      costUsd: 0,
      model: { ref: 'p1/fast-model', label: 'Fast', providerName: 'Provider1', source: 'default' },
      mandate: { strength: 'direct', actor: { source: 'cli', id: 'op' }, scope: 'cli', policyVersion: '1' },
      secrets: [],
      assignments: [],
      reports: [{ id: 'a1', assignmentId: 'a1', state: 'ready', summary: '核对完成 350.75', at: new Date().toISOString() }],
      canRetry: false,
      inputs: [],
      messages: [],
      workspace: { path: root, exists: true, fileCount: 1 },
    } : undefined,
    deliverables: () => [{ path: 'output/sales-report.md', size: 256, mtime: new Date().toISOString(), kind: 'md' }],
    secretRequests: () => [],
    createTicket,
  } as unknown as AdminHost

  return { db, ledger, events, store, options, host, goals, contracts, plugins, createTicket }
}

describe('Director V2.4 能力全面升级', () => {
  it('dispatch_ticket 正确透传 worktree 与 0 Token script 执行器，且 ticket_receipt 返回完整交付回执', async () => {
    const deps = makeDeps()
    const svc = new DirectorService({
      host: deps.host,
      options: deps.options,
      ledger: deps.ledger,
      events: deps.events,
      store: deps.store,
      goals: deps.goals,
      contracts: deps.contracts,
      plugins: deps.plugins,
      redact: s => s,
    })

    const session = deps.store.getOrCreateSession('web', 'owner')
    const dispatchRes = await svc.tools.run('dispatch_ticket', {
      prompt: '核对销售 CSV',
      projectId: 'p_sales',
      projectMode: 'worktree',
      runnerId: 'script',
      scriptId: 'sales-report-check',
      scriptParams_json: JSON.stringify({ inputFile: 'project/sales.csv', dateField: 'paid_at', decimals: 2 }),
      goal_json: JSON.stringify({ description: '核对销售数据', criteria: ['金额两位小数'], requireEvidence: true }),
    }, { session, confirmHighRisk: true })

    expect(dispatchRes.ok).toBe(true)
    expect(deps.createTicket).toHaveBeenCalledTimes(1)
    const callArgs = deps.createTicket.mock.calls[0] as unknown[]
    expect(callArgs[3]).toBe('p_sales')
    expect(callArgs[6]).toBe('worktree')
    expect(callArgs[7]).toEqual({
      runnerId: 'script',
      scriptId: 'sales-report-check',
      scriptParams: { inputFile: 'project/sales.csv', dateField: 'paid_at', decimals: 2 },
    })

    const receiptRes = await svc.tools.run('platform_query', {
      action: 'ticket_receipt',
      params_json: JSON.stringify({ ticketId: 't_r1' }),
    }, { session, confirmHighRisk: true })
    expect(receiptRes.ok).toBe(true)
    const parsed = JSON.parse(receiptRes.output)
    expect(parsed.receipt.deliverables[0].path).toBe('output/sales-report.md')
    expect(parsed.receipt.evidences[0].summary).toContain('350.75')
    expect(parsed.contract.version).toBe(1)
    deps.db.close()
  })

  it('实时态势快照预注入 + 主模型故障自动切换备选模型 + /帮助 与 /计划 零成本秒回', async () => {
    const deps = makeDeps()
    let seenSystem = ''
    const seenModels: string[] = []
    const callTool = vi.fn(async (_target, req) => {
      seenSystem = req.system
      seenModels.push(req.model)
      if (req.model === 'fast-model') {
        return { ok: false, status: 503, error: 'upstream overloaded', text: '', toolCalls: [], latencyMs: 25 }
      }
      return { ok: true, status: 200, text: '已由备选模型顺利完成处理。', toolCalls: [], latencyMs: 30 }
    })

    const svc = new DirectorService({
      host: deps.host,
      options: deps.options,
      ledger: deps.ledger,
      events: deps.events,
      store: deps.store,
      goals: deps.goals,
      contracts: deps.contracts,
      plugins: deps.plugins,
      redact: s => s,
      callTool: callTool as never,
    })

    // 1. /帮助 与 /计划 快捷口令不消耗任何模型调用
    const helpRes = await svc.chat({ channel: 'web', userId: 'u1', text: '/帮助' })
    expect(helpRes.shortcut).toBe('help')
    expect(helpRes.reply).toContain('/计划')
    const plansRes = await svc.chat({ channel: 'web', userId: 'u1', text: '/计划' })
    expect(plansRes.shortcut).toBe('plans')
    expect(callTool).toHaveBeenCalledTimes(0)

    // 2. 主模型 503 自动降级至备选模型 backup-model，并验证系统提示词已预注实时平台快照
    const chatRes = await svc.chat({ channel: 'web', userId: 'u1', text: '帮我看看现在工单状态' })
    expect(chatRes.modelFailed).toBeUndefined()
    expect(chatRes.model).toBe('p1/backup-model')
    expect(chatRes.reply).toContain('备选模型顺利完成')
    expect(seenModels).toEqual(['fast-model', 'backup-model'])
    expect(seenSystem).toContain('平台实时态势快照')
    expect(seenSystem).toContain('核对销售周报')
    deps.db.close()
  })

  it('单轮多个只读工具并行执行并按原序回传，且支持 AbortSignal 及时中止', async () => {
    const deps = makeDeps()
    let step = 0
    const callTool = vi.fn(async (_target, req) => {
      step += 1
      if (step === 1) {
        return {
          ok: true,
          status: 200,
          text: '',
          toolCalls: [
            { id: 'c1', name: 'platform_query', arguments: { action: 'overview' } },
            { id: 'c2', name: 'platform_query', arguments: { action: 'ticket_receipt', params_json: JSON.stringify({ ticketId: 't_r1' }) } },
          ],
          latencyMs: 15,
        }
      }
      const toolMsgs = req.messages.filter((m: { role: string }) => m.role === 'tool')
      expect(toolMsgs).toHaveLength(2)
      expect(toolMsgs[0].toolCallId).toBe('c1')
      expect(toolMsgs[1].toolCallId).toBe('c2')
      return { ok: true, status: 200, text: '已并发查完概览与交付回执。', toolCalls: [], latencyMs: 15 }
    })

    const svc = new DirectorService({
      host: deps.host,
      options: deps.options,
      ledger: deps.ledger,
      events: deps.events,
      store: deps.store,
      goals: deps.goals,
      contracts: deps.contracts,
      plugins: deps.plugins,
      redact: s => s,
      callTool: callTool as never,
    })

    // 监视 tools.run 确认两次只读工具同时进入执行
    let inFlight = 0
    let maxInFlight = 0
    const origRun = svc.tools.run.bind(svc.tools)
    vi.spyOn(svc.tools, 'run').mockImplementation(async (name, args, ctx) => {
      inFlight += 1
      maxInFlight = Math.max(maxInFlight, inFlight)
      await new Promise(r => setTimeout(r, 20))
      try {
        return await origRun(name, args, ctx)
      } finally {
        inFlight -= 1
      }
    })

    const res = await svc.chat({ channel: 'web', userId: 'u_par', text: '概览和回执一起给我' })
    expect(res.reply).toContain('并发查完')
    expect(res.toolsUsed).toHaveLength(2)
    expect(maxInFlight).toBe(2)

    // 验证 AbortSignal 预中止时立即退出、不发起新模型调用
    const ac = new AbortController()
    ac.abort()
    const beforeCalls = callTool.mock.calls.length
    const aborted = await svc.chat({ channel: 'web', userId: 'u_par', text: '继续查点别的', signal: ac.signal })
    expect(callTool.mock.calls.length).toBe(beforeCalls)
    expect(aborted.reply).toContain('中止')
    deps.db.close()
  })

  it('支持批量删除多个会话（级联清理全部关联表）与批量删除单会话内多条消息（自动清理关联 tool 消息）', async () => {
    const deps = makeDeps()
    const svc = new DirectorService({
      host: deps.host,
      options: deps.options,
      ledger: deps.ledger,
      events: deps.events,
      store: deps.store,
      goals: deps.goals,
      contracts: deps.contracts,
      plugins: deps.plugins,
      redact: s => s,
    })

    const s1 = deps.store.getOrCreateSession('web', 'u_del_1')
    const s2 = deps.store.getOrCreateSession('web', 'u_del_2')
    const sKeep = deps.store.getOrCreateSession('web', 'u_keep')

    deps.store.addMessage({ sessionId: s1.id, role: 'user', content: 's1 msg' })
    deps.store.createPendingAction({ sessionId: s1.id, toolName: 'host_ops', args: {}, summary: 'test' })
    deps.store.linkTicket('tk_1', s1)
    deps.store.addUndelivered(s1, 'offline')
    deps.store.createFollowup({ sessionId: s1.id, triggerKind: 'ticket.ended', targetId: 'tk_1', instruction: 'next' })

    deps.store.addMessage({ sessionId: s2.id, role: 'user', content: 's2 msg' })

    const mUser = deps.store.addMessage({ sessionId: sKeep.id, role: 'user', content: '保留对话第 1 条' })
    const mAsstTool = deps.store.addMessage({
      sessionId: sKeep.id,
      role: 'assistant',
      content: '查一下',
      toolCalls: [{ id: 'tc_del_1', name: 'platform_query', arguments: { action: 'overview' } }],
    })
    deps.store.addMessage({ sessionId: sKeep.id, role: 'tool', content: '{"ok":true}', toolCallId: 'tc_del_1', toolName: 'platform_query' })
    const mKeepFinal = deps.store.addMessage({ sessionId: sKeep.id, role: 'assistant', content: '保留这条最终回复' })

    // 1. 批量删除 s1 与 s2
    const batchRes = svc.deleteSessions([s1.id, s2.id, 'nonexistent_id'])
    expect(batchRes.deleted).toBe(2)
    expect(batchRes.ids).toEqual([s1.id, s2.id])
    expect(deps.store.listSessions().map(s => s.id)).toEqual([sKeep.id])
    expect(deps.store.recentMessages(s1.id)).toHaveLength(0)
    expect(deps.store.listPendingActions(s1.id)).toHaveLength(0)
    expect(deps.store.listFollowups(s1.id)).toHaveLength(0)
    expect(deps.store.takeUndelivered(s1.id)).toHaveLength(0)

    // 2. 在保留会话内批量删除用户消息与带 toolCalls 的助手消息，验证关联 tool 结果同步清理且最终回复保留
    const delMsgsRes = svc.deleteMessages(sKeep.id, [mUser.id, mAsstTool.id])
    expect(delMsgsRes).toEqual({ ok: true, deleted: 2 })
    const remaining = deps.store.recentMessages(sKeep.id)
    expect(remaining.map(m => m.id)).toEqual([mKeepFinal.id])

    // 3. 单个删除最后一个会话
    expect(svc.deleteSession(sKeep.id)).toBe(true)
    expect(svc.deleteSession(sKeep.id)).toBe(false)
    expect(deps.store.listSessions()).toHaveLength(0)
    deps.db.close()
  })
})
