/**
 * 全能型自治总控助手（P0 飞书交互卡片一键确认 + P1 主动盯盘看门狗与故障自愈闭环 + P2 经验反哺与里程碑播报）回归测试。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OptionsStore, defaultOptions } from '../src/admin/options.ts'
import type { AdminHost } from '../src/admin/host.ts'
import { DirectorBridge } from '../src/director/bridge.ts'
import { callToolModel } from '../src/director/llm.ts'
import { DirectorService } from '../src/director/service.ts'
import { DirectorStore } from '../src/director/store.ts'
import { DirectorWatchdog } from '../src/director/watchdog.ts'
import { EventLog } from '../src/ledger/events.ts'
import { Ledger } from '../src/ledger/ledger.ts'
import type { ActivityLog, ActivityView } from '../src/executor/activity.ts'
import { PluginRegistry } from '../src/plugins/registry.ts'
import { FeishuWs } from '../src/sources/feishu-ws.ts'
import {
  buildMissionApprovalCard,
  buildPendingActionCard,
  buildTicketDecisionCard,
  buildVaultRequestCard,
  parseFeishuCardActionEvent,
} from '../src/sources/feishu-cards.ts'

const dirs: string[] = []
function tempDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(d)
  return d
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function makeHarness(overrides?: {
  callTool?: ReturnType<typeof vi.fn>
  diskFreeGb?: number
  openTickets?: { id: string; title: string; status: 'open'; stage: string; needsPerson: boolean; createdAt: string; updatedAt: string; costUsd: number }[]
  activityUpdatedAt?: string
  missions?: unknown[]
}) {
  const root = tempDir('sa-dir-auto-')
  const db = new DatabaseSync(':memory:')
  const ledger = new Ledger(db)
  const events = new EventLog(db)
  const store = new DirectorStore(db)
  const plugins = new PluginRegistry({ db })
  const savedMemories: Record<string, unknown>[] = []

  // 注册轻量模拟插件以验证 memory_save 反哺与 missions_list 巡检
  plugins.register({
    id: 'mock-core',
    name: 'Mock Core',
    description: 'test',
    version: '1.0.0',
    directorQueries: {
      missions_list: () => ({ items: overrides?.missions ?? [] }),
    },
    directorActions: {
      memory_save: (args: Record<string, unknown>) => {
        savedMemories.push(args)
        return { ok: true, id: `mem_${savedMemories.length}` }
      },
    },
  })

  const optsDef = defaultOptions({})
  optsDef.models.providers = [
    {
      id: 'p1',
      name: 'Provider1',
      api: 'openai-completions',
      baseUrl: 'https://example.invalid/v1',
      apiKey: 'sk-test',
      sessionHeader: '',
      enabled: true,
      models: [
        { id: 'm1', label: 'M1', description: '', reasoning: false, vision: false, contextWindow: 64000, maxTokens: 4096, autoPick: true, price: { input: 0, cacheRead: 0, output: 0 } },
      ],
    },
  ]
  optsDef.models.routing.worker = { provider: 'p1', model: 'm1' }
  optsDef.models.routing.assessor = { ...optsDef.models.routing.assessor, provider: 'p1', model: 'm1' }
  optsDef.feishu.enabled = true
  optsDef.feishu.mode = 'ws'
  optsDef.feishu.routingMode = 'director'
  optsDef.director.enabled = true
  optsDef.director.model = { provider: 'p1', model: 'm1' }
  optsDef.director.maxRetries = 0
  optsDef.director.autoHeal = true
  optsDef.director.maxAutoHealRounds = 2
  optsDef.director.stallMinutes = 8
  optsDef.director.milestoneMinutes = 5
  optsDef.director.feishuInteractiveCards = true
  const options = new OptionsStore(join(root, 'options.json'), optsDef)

  const retryTicket = vi.fn(async () => undefined)
  const stopTicket = vi.fn(async () => undefined)
  const setPaused = vi.fn(() => undefined)
  const host = {
    overview: () => ({
      paused: false,
      acceptMode: 'auto',
      slots: { used: 1, max: 4, reservedForPerson: 1 },
      tickets: { open: overrides?.openTickets?.length ?? 0, running: overrides?.openTickets?.length ?? 0, needsPerson: 0, endedToday: 0 },
      attentionTickets: [],
      host: { load1: 0.2, cpuCount: 4, memUsedPct: 30, diskFreeGb: overrides?.diskFreeGb ?? 50 },
      upstream: { ok: true, model: 'm1', provider: 'Provider1' },
    }),
    listTickets: () => ({ total: overrides?.openTickets?.length ?? 0, items: overrides?.openTickets ?? [] }),
    ticket: (id: string) => ({
      id,
      title: '订单页改造与自检',
      status: 'open',
      stage: 'working',
      needsPerson: false,
      createdAt: '2026-11-23T12:00:00.000Z',
      updatedAt: '2026-11-23T12:01:00.000Z',
      costUsd: 0.02,
      model: { ref: 'p1/m1', label: 'M1', providerName: 'Provider1', source: 'default' },
      mandate: { strength: 'direct', actor: { source: 'cli', id: 'op' }, scope: 'cli', policyVersion: '1' },
      secrets: [],
      assignments: [],
      reports: [{ id: 'r1', assignmentId: 'a1', state: 'failed', summary: 'npm test exited with code 1: missing dep', at: '2026-11-23T12:01:00.000Z' }],
      canRetry: true,
      inputs: [],
      messages: [],
      workspace: { path: root, exists: true, fileCount: 3 },
    }),
    deliverables: () => [{ path: 'output/report.md', size: 120, mtime: '2026-11-23T12:02:00.000Z', kind: 'md' }],
    secretRequests: () => [],
    retryTicket,
    stopTicket,
    setPaused,
  } as unknown as AdminHost

  const sendFeishu = vi.fn(async () => undefined)
  const sendFeishuCard = vi.fn(async () => ({ messageId: 'om_card_001' }))
  const updateFeishuCard = vi.fn(async (_messageId: string, _card: Record<string, unknown>) => undefined)
  const sendWechat = vi.fn(async () => undefined)
  const decideSecretRequest = vi.fn(async () => ({ ok: true, message: '已批准密钥授权' }))
  const approveMissionNode = vi.fn(async () => ({ ok: true, message: '已批准节点继续' }))
  const cancelMission = vi.fn(async () => ({ ok: true, message: '已取消计划' }))

  const activity: Pick<ActivityLog, 'list'> = {
    list: (): ActivityView => ({
      items: [{ id: 1, seq: 1, at: overrides?.activityUpdatedAt ?? '2026-11-23T12:01:00.000Z', kind: 'tool' as const, tool: 'bash', summary: 'pnpm test', status: 'done' as const }],
      last: 1,
      updatedAt: overrides?.activityUpdatedAt ?? '2026-11-23T12:01:00.000Z',
    }),
  }

  const director = new DirectorService({
    host,
    options,
    ledger,
    events,
    store,
    activity,
    plugins,
    redact: s => s,
    sendFeishu,
    sendFeishuCard,
    updateFeishuCard,
    feishuAllowCheck: openId => openId === 'ou_owner',
    decideSecretRequest,
    approveMissionNode,
    cancelMission,
    ...(overrides?.callTool ? { callTool: overrides.callTool as never } : {}),
  })

  const bridge = new DirectorBridge({
    director,
    options,
    host,
    events,
    sendWechat,
    sendFeishu,
    sendFeishuCard,
    feishuRecipients: () => ['ou_owner'],
  })

  return {
    db,
    store,
    options,
    events,
    host,
    activity,
    plugins,
    director,
    bridge,
    savedMemories,
    mocks: {
      sendFeishu,
      sendFeishuCard,
      updateFeishuCard,
      sendWechat,
      retryTicket,
      stopTicket,
      setPaused,
      decideSecretRequest,
      approveMissionNode,
      cancelMission,
    },
  }
}

describe('P0: 飞书交互式按钮卡片一键点击确认', () => {
  it('正确构建 4 类 JSON 2.0 交互卡片并兼容 WS/Webhook 回调结构解析', () => {
    const c1 = buildPendingActionCard({ actionId: 'ABCD', toolName: 'host_ops', summary: '重启服务' })
    const c2 = buildMissionApprovalCard({ missionId: 'm_1', missionTitle: '发布计划', nodeKey: 'pub', nodeTitle: '上线审批', planVersion: 2 })
    const c3 = buildVaultRequestCard({ requestId: 'sr_1', ticketId: 'tk_1', ticketTitle: '部署', secretName: 'GITHUB_TOKEN', why: '开 PR' })
    const c4 = buildTicketDecisionCard({ ticketId: 'tk_2', title: '构建失败', reason: '超限', diagnosis: '缺依赖', attempts: 2 })
    expect(c1.schema).toBe('2.0')
    expect(c2.schema).toBe('2.0')
    expect(c3.schema).toBe('2.0')
    expect(c4.schema).toBe('2.0')

    // 长连接 WS 2.0 嵌套 context 结构
    const wsEvt = parseFeishuCardActionEvent({
      header: { event_id: 'ev_1', event_type: 'card.action.trigger' },
      event: {
        operator: { open_id: 'ou_owner' },
        context: { open_message_id: 'om_123', open_chat_id: 'oc_456' },
        action: { value: { kind: 'director_action', actionId: 'ABCD', decision: 'approve' } },
      },
    })
    expect(wsEvt).toEqual({
      eventId: 'ev_1',
      operatorOpenId: 'ou_owner',
      openMessageId: 'om_123',
      openChatId: 'oc_456',
      actionValue: { kind: 'director_action', actionId: 'ABCD', decision: 'approve' },
    })

    // HTTP Webhook 顶层字段兼容
    const whEvt = parseFeishuCardActionEvent({
      open_id: 'ou_owner',
      open_message_id: 'om_999',
      action: { value: JSON.stringify({ kind: 'mission_approval', missionId: 'm_1', nodeKey: 'pub', planVersion: 2, decision: 'approve' }) },
    })
    expect(whEvt?.actionValue).toMatchObject({ kind: 'mission_approval', missionId: 'm_1', planVersion: 2, decision: 'approve' })
  })

  it('飞书长连接 FeishuWs 接收 card.action.trigger 并将 toast/card 返回给 SDK，同时完成鉴权、3 秒快返与异步原位刷新卡片', async () => {
    const h = makeHarness()
    const sess = h.store.getOrCreateSession('feishu', 'ou_owner')
    const act = h.store.createPendingAction({
      sessionId: sess.id,
      toolName: 'high_risk_action',
      args: { action: 'platform_set_paused', params_json: JSON.stringify({ paused: true }) },
      summary: '暂停平台接单',
    })

    // 捕获 FeishuWs 注册的 EventDispatcher
    let capturedDispatcher: { invoke: (data: unknown, opts?: unknown) => Promise<unknown> } | undefined
    const ws = new FeishuWs({
      config: () => ({ appId: 'cli_a', appSecret: 'sec_b', verificationToken: 'vt', encryptKey: '', groupMode: 'mention' }),
      onTrigger: () => undefined,
      onCardAction: evt => h.director.handleFeishuCardAction(evt),
      clientFactory: () => ({
        start: async ({ eventDispatcher }) => {
          capturedDispatcher = eventDispatcher as unknown as typeof capturedDispatcher
        },
        close: () => undefined,
      }),
    })
    await ws.start()
    expect(capturedDispatcher).toBeDefined()

    // 1. 非白名单用户点击 -> 拒绝且不执行
    const denied = await capturedDispatcher!.invoke({
      schema: '2.0',
      header: { event_type: 'card.action.trigger', event_id: 'ev_deny' },
      event: {
        operator: { open_id: 'ou_intruder' },
        context: { open_message_id: 'om_1' },
        action: { value: { kind: 'director_action', actionId: act.id, decision: 'approve' } },
      },
    }, { needCheck: false }) as { toast?: { type: string } }
    expect(denied?.toast?.type).toBe('error')
    expect(h.mocks.setPaused).not.toHaveBeenCalled()

    // 2. 授权主人点击「✅ 确认执行」-> 立刻返回「正在后台执行」锁定卡片，随后异步执行并调用 updateFeishuCard 原位更新结果
    const approved = await capturedDispatcher!.invoke({
      schema: '2.0',
      header: { event_type: 'card.action.trigger', event_id: 'ev_ok' },
      event: {
        operator: { open_id: 'ou_owner' },
        context: { open_message_id: 'om_card_live' },
        action: { value: { kind: 'director_action', actionId: act.id, decision: 'approve' } },
      },
    }, { needCheck: false }) as { toast?: { type: string; content: string }; card?: { type: string; data: Record<string, unknown> } }
    expect(approved?.toast?.type).toBe('info')
    expect(approved?.card?.type).toBe('raw')
    expect(JSON.stringify(approved?.card?.data)).toContain('正在后台执行')

    // 等待异步后台执行完毕
    await new Promise(r => setTimeout(r, 60))
    expect(h.mocks.setPaused).toHaveBeenCalledWith(true)
    expect(h.mocks.updateFeishuCard).toHaveBeenCalledTimes(1)
    expect(h.mocks.updateFeishuCard.mock.calls[0]?.[0]).toBe('om_card_live')
    expect(JSON.stringify(h.mocks.updateFeishuCard.mock.calls[0]?.[1])).toContain('已执行')

    // 3. 覆盖 DAG 审批、密钥授权与工单重试按钮回调
    const mRes = await h.director.handleFeishuCardAction({
      operatorOpenId: 'ou_owner',
      actionValue: { kind: 'mission_approval', missionId: 'm_1', nodeKey: 'pub', planVersion: 2, decision: 'approve' },
    })
    expect(mRes.toast?.type).toBe('success')
    expect(h.mocks.approveMissionNode).toHaveBeenCalledTimes(1)

    const vRes = await h.director.handleFeishuCardAction({
      operatorOpenId: 'ou_owner',
      actionValue: { kind: 'vault_request', requestId: 'sr_1', ticketId: 'tk_1', secretName: 'API_KEY', decision: 'approve' },
    })
    expect(vRes.toast?.type).toBe('success')
    expect(h.mocks.decideSecretRequest).toHaveBeenCalledWith('sr_1', 'approve')

    const tRes = await h.director.handleFeishuCardAction({
      operatorOpenId: 'ou_owner',
      actionValue: { kind: 'ticket_op', ticketId: 'tk_9', op: 'retry' },
    })
    expect(tRes.toast?.type).toBe('success')
    expect(h.mocks.retryTicket).toHaveBeenCalledWith('tk_9')

    ws.stop()
    h.db.close()
  })
})

describe('P1 + P2: 主动盯盘看门狗、故障自愈闭环、解决后汇报与避坑经验沉淀', () => {
  it('看门狗发现卡死工单 -> 唤醒总控 ticket_diagnose + 重试修复 -> 完工后发闭环战报并自动沉淀长期记忆，超限则推飞书决策卡片', async () => {
    let callStep = 0
    const callTool = vi.fn(async (_target, req) => {
      callStep += 1
      const userPrompt = String(req.messages.at(-1)?.content ?? '')
      // 轮次 1：自愈唤醒时先调用 ticket_diagnose 查现场，再重试工单
      if (userPrompt.includes('主动排障自愈唤醒')) {
        return {
          ok: true,
          status: 200,
          text: '',
          toolCalls: [
            { id: `diag_${callStep}`, name: 'platform_query', arguments: { action: 'ticket_diagnose', params_json: JSON.stringify({ ticketId: 'tk_stalled_1' }) } },
          ],
          latencyMs: 12,
        }
      }
      if (req.messages.some((m: { role: string; toolCallId?: string }) => m.role === 'tool' && String(m.toolCallId).startsWith('diag_'))) {
        if (!req.messages.some((m: { role: string; toolCallId?: string }) => m.role === 'tool' && String(m.toolCallId).startsWith('retry_'))) {
          return {
            ok: true,
            status: 200,
            text: '',
            toolCalls: [
              { id: `retry_${callStep}`, name: 'ticket_manage', arguments: { action: 'ticket_retry', ticketId: 'tk_stalled_1', params_json: '{}' } },
            ],
            latencyMs: 10,
          }
        }
        return {
          ok: true,
          status: 200,
          text: '已查明卡死原因是测试进程挂起，我已为你重新启动工单 tk_stalled_1，完成后立即向你汇报。',
          toolCalls: [],
          latencyMs: 10,
        }
      }
      // 自愈成功后闭环汇报
      return {
        ok: true,
        status: 200,
        text: '✅ 故障已自动解决并验证完成：此前工单 tk_stalled_1 卡在测试环节，经重跑已通过全部验证，交付物位于 output/report.md。',
        toolCalls: [],
        latencyMs: 10,
      }
    })

    const nowTime = new Date('2026-11-23T12:15:00.000Z')
    const h = makeHarness({
      callTool,
      diskFreeGb: 1.2,
      openTickets: [
        {
          id: 'tk_stalled_1',
          title: '订单页改造与自检',
          status: 'open',
          stage: 'working',
          needsPerson: false,
          createdAt: '2026-11-23T12:00:00.000Z',
          updatedAt: '2026-11-23T12:02:00.000Z',
          costUsd: 0.02,
        },
      ],
      activityUpdatedAt: '2026-11-23T12:02:00.000Z', // 距 12:15 已停滞 13 分钟 >= stallMinutes(8)
      missions: [
        {
          id: 'm_wait_1',
          title: '发布上线计划',
          status: 'running',
          planVersion: 1,
          nodes: [{ key: 'approve_go', title: '确认发布', status: 'waiting_approval', prompt: '请确认上线' }],
        },
      ],
    })

    const watchdog = new DirectorWatchdog({
      bridge: h.bridge,
      host: h.host,
      options: h.options,
      events: h.events,
      activity: h.activity,
      plugins: h.plugins,
      now: () => nowTime,
    })

    // 1. 执行一轮看门狗巡检：发现卡死工单 + 发现 DAG 待审批节点 + 发现磁盘 < 2GB 预警
    await watchdog.tick()

    // 验证：总控主动查现场并调用了 ticket_retry，且记录了第 1 轮自愈计数
    expect(h.mocks.retryTicket).toHaveBeenCalledWith('tk_stalled_1')
    expect(h.store.getHealState('ticket:tk_stalled_1')?.attempts).toBe(1)
    // 验证：DAG 待审批节点自动发了飞书交互审批卡片
    expect(h.mocks.sendFeishuCard).toHaveBeenCalled()
    expect(JSON.stringify(h.mocks.sendFeishuCard.mock.calls)).toContain('mission_approval')
    // 验证：磁盘不足 <2GB 触发预警
    expect(JSON.stringify(h.mocks.sendFeishu.mock.calls)).toContain('磁盘剩余空间不足')

    // 2. 模拟自愈后的工单最终成功完工 -> 触发自愈闭环战报 + 自动兜底沉淀避坑经验到长期记忆
    await h.bridge.notify({
      kind: 'ticket.ended',
      ticketId: 'tk_stalled_1',
      title: '订单页改造与自检',
      outcome: 'completed',
      summary: '全部测试通过，交付完成',
    })
    expect(h.store.getHealState('ticket:tk_stalled_1')?.status).toBe('resolved')
    expect(h.savedMemories.length).toBeGreaterThanOrEqual(1)
    expect(h.savedMemories[0]).toMatchObject({ kind: 'pitfall', tags: ['auto_heal'] })

    // 3. 验证防死循环护栏：另一张工单达到 maxAutoHealRounds(2) 后再失败，直接升级推送飞书一键决策卡片
    h.store.recordHealAttempt('ticket:tk_exhaust', 'err 1')
    h.store.recordHealAttempt('ticket:tk_exhaust', 'err 2')
    h.mocks.sendFeishuCard.mockClear()
    await h.bridge.notify({
      kind: 'ticket.ended',
      ticketId: 'tk_exhaust',
      title: '持续失败任务',
      outcome: 'failed',
      summary: '第 3 次依然报连接被拒',
    })
    expect(h.store.getHealState('ticket:tk_exhaust')?.status).toBe('escalated')
    expect(h.mocks.sendFeishuCard).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(h.mocks.sendFeishuCard.mock.calls[0])).toContain('ticket_op')
    h.db.close()
  })
})

describe('模型故障/超时不丢需求：重试额度完整生效 + 自动续跑', () => {
  it('备选模型不再被硬限 2 次重试，且主/备模型都失败时自动排队续跑并在恢复后推送结果', async () => {
    vi.useFakeTimers()
    try {
      const seenRetries: number[] = []
      let phase = 0
      const callTool = vi.fn(async (_t, req, opts: { maxRetries?: number }) => {
        seenRetries.push(opts.maxRetries ?? -1)
        phase += 1
        // 前两次调用（主模型 + 自动降级的备选模型）均连接重置；续跑后恢复正常
        if (phase <= 2) return { ok: false, status: 0, error: 'fetch failed (ECONNRESET)', text: '', toolCalls: [], latencyMs: 5 }
        return { ok: true, status: 200, text: '已为你处理完成：任务已派发并核实。', toolCalls: [], latencyMs: 5 }
      })
      const h = makeHarness({ callTool })
      // 增加一个可降级的备选模型
      const cfg = h.options.get()
      expect(cfg.director.maxAutoHealRounds).toBeGreaterThan(0)
      h.options.update('director', { ...cfg.director, maxRetries: 10 })

      const res = await h.director.chat({ channel: 'feishu', userId: 'ou_owner', text: '帮我把订单页改成深色主题' })
      expect(res.modelFailed).toBe(true)
      expect(res.resumeScheduled).toBe(true)
      expect(res.reply).toContain('自动重试')
      // 所有调用均应带满用户设置的 10 次重试额度（旧版备选模型被硬限为 2）
      expect(seenRetries.every(n => n === 10)).toBe(true)

      // 推进定时器：自动续跑成功后把结果推送到飞书
      await vi.advanceTimersByTimeAsync(31_000)
      await vi.runOnlyPendingTimersAsync()
      await Promise.resolve()
      const pushed = JSON.stringify([...h.mocks.sendFeishu.mock.calls, ...h.mocks.sendFeishuCard.mock.calls])
      expect(pushed).toContain('已为你处理完成')
      h.db.close()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('上游网关挂起（接了连接却不吐字）：首字节看门狗截断并换新连接重试', () => {
  const target = { api: 'openai-completions' as const, baseUrl: 'https://gw.example.com/v1', apiKey: 'sk-x' }
  const req = { model: 'm', system: 's', messages: [{ role: 'user' as const, content: 'hi' }], tools: [], maxTokens: 64 }

  function hangingFetch(hangTimes: number) {
    let calls = 0
    const seenConnection: (string | undefined)[] = []
    const fn: typeof fetch = (_url, init) => {
      calls += 1
      seenConnection.push((init?.headers as Record<string, string> | undefined)?.connection)
      if (calls <= hangTimes) {
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))
        })
      }
      return Promise.resolve(new Response(JSON.stringify({ choices: [{ message: { content: '恢复正常' }, finish_reason: 'stop' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }))
    }
    return { fn, calls: () => calls, seenConnection }
  }

  it('连续 2 次挂起后第 3 次成功：不必干等满整个步骤预算，且重试使用 connection: close 新连接', async () => {
    vi.useFakeTimers()
    try {
      const h = hangingFetch(2)
      const p = callToolModel(target, req, { timeoutMs: 144_000, stream: true, maxRetries: 10, retryDelayMs: 50, fetch: h.fn })
      await vi.advanceTimersByTimeAsync(100_000)
      const res = await p
      expect(res.ok).toBe(true)
      expect(res.text).toBe('恢复正常')
      expect(h.calls()).toBe(3)
      expect(h.seenConnection[0]).toBeUndefined()
      expect(h.seenConnection[1]).toBe('close')
    } finally {
      vi.useRealTimers()
    }
  })

  it('重试额度用尽仍挂起时给出清晰的「上游连接挂起」提示而不是笼统的超时', async () => {
    vi.useFakeTimers()
    try {
      const h = hangingFetch(99)
      const p = callToolModel(target, req, { timeoutMs: 144_000, stream: true, maxRetries: 1, retryDelayMs: 50, fetch: h.fn })
      await vi.advanceTimersByTimeAsync(120_000)
      const res = await p
      expect(res.ok).toBe(false)
      expect(res.error).toContain('上游连接挂起')
      expect(res.error).toContain('已自动重试 1 次')
      expect(h.calls()).toBe(2)
    } finally {
      vi.useRealTimers()
    }
  })
})
