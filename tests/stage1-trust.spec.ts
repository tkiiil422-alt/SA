/**
 * Stage 1（第一优先级：正确理解与可信交付）核心回归与验收测试：
 * 1. Bug 1 回归：裁判仅返回 {"met":true} 且无证据时绝不能判通过。
 * 2. Bug 2 回归：closed / dropped 工单带摘要时，复盘严禁打上 completed 标签，须分别记录终态与验收状态。
 * 3. Bug 3 回归：写入唯一关键词记忆后再插入 320+ 条无关记录，仍可精准召回并严格遵守项目隔离。
 * 4. 统一任务约定 + 周报口径升级场景（v1 旧报告保留旧口径，v2 自动应用新口径并更新长期记忆）。
 * 5. 调度记录三态分列（已派发 / 已执行 / 已验收）与逐项证据绑定交付回执（DeliveryReceipt）。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { GoalService, resolveGoal } from '../src/goal/service.ts'
import { MemoryStore } from '../src/memory/store.ts'
import { SkillStore } from '../src/skills/store.ts'
import { createMemoryAndSkillsPlugin } from '../src/memory/plugin.ts'
import { ContractStore } from '../src/contracts/store.ts'
import { createContractsPlugin } from '../src/contracts/plugin.ts'
import { SchedulerStore } from '../src/scheduler/store.ts'
import { SchedulerService } from '../src/scheduler/service.ts'
import { createSchedulerPlugin } from '../src/scheduler/plugin.ts'
import { EventLog } from '../src/ledger/events.ts'
import { PluginRegistry } from '../src/plugins/registry.ts'
import { createRuntime } from '../src/runtime.ts'
import { parseConfig } from '../src/config.ts'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'

const FAKE_PI = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-pi.mjs')

const dirs: string[] = []
function tempDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(d)
  return d
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('Stage 1 — 三个已观察缺陷回归与可信交付', () => {
  it('Bug 1 回归：裁判仅返回 {"met":true} 没有任何证据时，拒绝让需要证据的任务通过', async () => {
    const db = new DatabaseSync(':memory:')
    const reports: unknown[] = []
    const goals = new GoalService({
      db,
      ticket: id => ({ triggerId: `trg_${id}`, ended: false, waitsForPerson: false, undelivered: 0 }),
      spend: () => 0.1,
      settings: () => ({ maxRounds: 4, maxUsd: 5, maxHours: 2, commandTimeoutSec: 30, judge: null }),
      run: async (_id, cmd) => ({ command: cmd, code: 0, ms: 10, tail: 'ok' }),
      // 模拟裁判偷懒：只给 met: true，evidence 为空数组
      judge: async () => ({ ok: true, verdict: { met: true, evidence: [], missing: [], summary: '' } }),
      report: (_id, rep) => { reports.push(rep) },
      artifactVersion: () => 'git:abc1234',
    })

    const spec = resolveGoal({
      text: '核对销售周报金额并确保全部保留两位小数',
      mode: 'ai',
      criteria: [{ id: 'c1', text: '全部金额保留两位小数', required: true }],
      requireEvidence: true,
    }, { maxRounds: 4, maxUsd: 5, maxHours: 2 })
    goals.set('t_bug1', spec)

    const decision1 = await goals.gate('t_bug1', { state: 'ready', summary: '已经改完了' })
    expect(decision1.action).toBe('replace')
    if (decision1.action === 'replace') {
      expect(decision1.report.state).toBe('progress')
      expect(decision1.reply).toContain('证据')
    }
    const viewAfterFail = goals.view('t_bug1')!
    expect(viewAfterFail.status).toBe('active')
    expect(viewAfterFail.last?.met).toBe(false)

    // 当补充了客观通过证据并绑定 criterionId、runId 与 artifactVersion 后，再次校验即可通过
    const ev = goals.recordEvidence('t_bug1', {
      kind: 'data',
      criterionId: 'c1',
      runId: 'run_sales_1',
      artifactVersion: 'report-v1.0',
      passed: true,
      summary: '校验 128 行记录，全部金额符合 ^\\d+\\.\\d{2}$',
    })
    expect(ev?.artifactVersion).toBe('report-v1.0')

    const decision2 = await goals.gate('t_bug1', { state: 'ready', summary: '已通过数据核对脚本校验' })
    expect(decision2.action).toBe('pass')
    expect(goals.view('t_bug1')?.status).toBe('met')

    const receipt = goals.buildReceipt('t_bug1', {
      deliverables: [{ path: 'output/sales-report.csv', size: 2048, kind: 'file' }],
      contractVersion: 1,
      contractCriteria: spec.criteria,
      ended: true,
      outcome: 'completed',
    })
    expect(receipt.status).toBe('verified')
    expect(receipt.deliverables).toHaveLength(1)
    expect(receipt.criteria[0]?.status).toBe('passed')
    expect(receipt.criteria[0]?.evidences[0]?.runId).toBe('run_sales_1')
    expect(receipt.criteria[0]?.evidences[0]?.artifactVersion).toBe('report-v1.0')
    expect(receipt.needsDecision).toBe(false)
    db.close()
  })

  it('Bug 2 回归：closed 与 dropped 工单有摘要时，复盘严禁打上 completed 标签，且准确记录终态与验收状态', () => {
    const dir = tempDir('sa-bug2-')
    const db = new DatabaseSync(':memory:')
    const memories = new MemoryStore(db)
    const skills = new SkillStore(db, join(dir, 'skills'))

    const ticketInfos: Record<string, { title: string; outcome: string; acceptanceStatus: 'met' | 'unmet' | 'not_checked'; summary: string; projectId?: string }> = {
      t_closed: {
        title: '调研第三方账单接口',
        outcome: 'closed',
        acceptanceStatus: 'not_checked',
        summary: '接口已下线，确认取消该方案并关闭工单以留存排查结论。',
      },
      t_dropped: {
        title: '临时数据迁移任务',
        outcome: 'dropped',
        acceptanceStatus: 'unmet',
        summary: '由于源库缺少只读权限导致多次失败，工单被放弃并记录原因。',
      },
      t_done: {
        title: '修复导出小数位',
        outcome: 'completed',
        acceptanceStatus: 'met',
        summary: '已修复金额导出格式并通过单元测试验证，输出精确到两位小数。',
      },
    }

    const plugin = createMemoryAndSkillsPlugin({
      memories,
      skills,
      redact: t => t,
      getTicketSummary: id => ticketInfos[id],
    })

    for (const id of ['t_closed', 't_dropped', 't_done']) {
      plugin.onDomainEvent?.({
        id: `ev_${id}`,
        type: 'ticket.ended',
        at: new Date().toISOString(),
        data: { ticketId: id, outcome: ticketInfos[id]!.outcome },
      } as never)
    }

    const all = memories.list({ kind: 'retro', limit: 20 }).items
    const closedMem = all.find(m => m.ticketId === 't_closed')!
    const droppedMem = all.find(m => m.ticketId === 't_dropped')!
    const doneMem = all.find(m => m.ticketId === 't_done')!

    expect(closedMem).toBeDefined()
    expect(closedMem.tags).not.toContain('completed')
    expect(closedMem.tags).toContain('outcome:closed')
    expect(closedMem.ticketOutcome).toBe('closed')
    expect(closedMem.acceptanceStatus).toBe('not_checked')

    expect(droppedMem).toBeDefined()
    expect(droppedMem.tags).not.toContain('completed')
    expect(droppedMem.tags).toContain('outcome:dropped')
    expect(droppedMem.ticketOutcome).toBe('dropped')
    expect(droppedMem.acceptanceStatus).toBe('unmet')

    expect(doneMem).toBeDefined()
    expect(doneMem.tags).toContain('completed')
    expect(doneMem.ticketOutcome).toBe('completed')
    expect(doneMem.acceptanceStatus).toBe('met')
    db.close()
  })

  it('Bug 3 回归：写入唯一关键词记忆后再插入 320 条无关记忆，仍能精准召回并严格遵守项目隔离', () => {
    const db = new DatabaseSync(':memory:')
    const memories = new MemoryStore(db)

    const targetGlobal = memories.save({
      scope: 'user',
      kind: 'preference',
      title: '财务对账专属密钥标识',
      content: '周报汇总必须按付款日期归集，标识符 ZEBRA_PAYDATE_9941 用于核对口径。',
      tags: ['finance', 'report'],
    })

    const targetProjA = memories.save({
      scope: 'project',
      kind: 'decision',
      projectId: 'p_alpha',
      title: 'Alpha 仓库编译规则',
      content: '项目 Alpha 必须使用特殊标记 QUARTZ_ALPHA_7731 运行构建脚本。',
      tags: ['build'],
    })

    // 连续写入 320 条无关噪音记忆，确保超出旧版 300 条上限
    for (let i = 0; i < 320; i += 1) {
      memories.save({
        scope: i % 2 === 0 ? 'user' : 'project',
        kind: 'fact',
        projectId: i % 2 === 0 ? null : 'p_noise',
        title: `日常无关记录 #${i}`,
        content: `这是一条用于压测召回容量的无关内容编号 ${i}，讨论天气与会议纪要。`,
        tags: ['noise'],
      })
    }

    const recalledGlobal = memories.recall({ query: '请按 ZEBRA_PAYDATE_9941 口径整理周报', limit: 6 })
    expect(recalledGlobal.some(m => m.id === targetGlobal.id)).toBe(true)

    // 在项目 Alpha 内查询应能召回 Alpha 专属记忆
    const recalledProjA = memories.recall({ query: 'QUARTZ_ALPHA_7731 构建步骤', projectId: 'p_alpha', limit: 6 })
    expect(recalledProjA.some(m => m.id === targetProjA.id)).toBe(true)

    // 在项目 Beta 内查询绝不能泄露项目 Alpha 专属记忆！
    const recalledProjB = memories.recall({ query: 'QUARTZ_ALPHA_7731 构建步骤', projectId: 'p_beta', limit: 6 })
    expect(recalledProjB.some(m => m.id === targetProjA.id)).toBe(false)
    db.close()
  })

  it('核心验收场景：每周五销售周报 → 中途纠正“按付款日期、金额保留两位小数” → 保留旧口径且下周自动用新口径 + 三态追踪', async () => {
    const db = new DatabaseSync(':memory:')
    const events = new EventLog(db)
    const memories = new MemoryStore(db)
    const contracts = new ContractStore(db)
    const schedulerStore = new SchedulerStore(db)

    const dispatched: { text: string; ticketId: string; goal?: unknown }[] = []
    let seq = 0
    const scheduler = new SchedulerService({
      store: schedulerStore,
      events,
      contracts,
      isPaused: () => false,
      dispatchTicket: async input => {
        seq += 1
        const ticketId = `t_sales_${seq}`
        dispatched.push({ text: input.text, ticketId, goal: input.goal })
        return { ticketId, triggerId: `trg_${seq}` }
      },
    })

    const plugins = new PluginRegistry()
    const contractsPlugin = createContractsPlugin({
      contracts,
      memories,
      redact: t => t,
    })
    plugins.register(contractsPlugin)
    plugins.register(createSchedulerPlugin(scheduler))

    // 1. 用户：“每周五整理销售周报给我”
    const sch = scheduler.create({
      name: '每周五销售周报',
      triggerKind: 'cron',
      cronExpr: '0 17 * * 5',
      actionKind: 'dispatch_ticket',
      actionConfig: { prompt: '整理本周销售周报并输出汇总文件', projectId: 'p_sales' },
    })

    // 初始建立 v1 约定（按订单创建日期统计）
    const c1 = contracts.save({
      targetKind: 'schedule',
      targetId: sch.id,
      projectId: 'p_sales',
      goal: '每周五整理销售周报并输出汇总文件',
      deliverables: ['output/weekly-sales.md'],
      criteria: [{ id: 'c1', text: '包含本周总销售额与分渠道明细（按创建日期统计）', required: true }],
      assumptions: ['默认统计日期口径为订单创建日期'],
    })
    expect(c1.version).toBe(1)

    // 第 1 周运行
    const run1 = await scheduler.runNow(sch.id)
    expect(run1.contractVersion).toBe(1)
    expect(run1.dispatchStatus).toBe('dispatched')
    expect(run1.executionStatus).toBe('running')
    expect(run1.acceptanceStatus).toBe('pending')
    expect(dispatched[0]!.text).toContain('按创建日期统计')

    // 第 1 周工单完成且通过验收 → 同步三态
    const settled1 = scheduler.onTicketSettled(run1.ticketId!, 'completed', 'met')!
    expect(settled1.dispatchStatus).toBe('dispatched')
    expect(settled1.executionStatus).toBe('succeeded')
    expect(settled1.acceptanceStatus).toBe('passed')

    // 2. 用户纠正：“以后按付款日期，金额保留两位小数”
    const amendResult = await contractsPlugin.directorActions!.contract_amend!(
      {
        targetKind: 'schedule',
        targetId: sch.id,
        scope: 'project',
        reason: '以后销售周报统一按付款日期统计，所有金额保留两位小数',
        criteria: [
          { id: 'c1', text: '统计日期口径必须为付款日期（paid_at）', required: true },
          { id: 'c2', text: '所有金额严格保留两位小数', required: true },
        ],
        assumptions: ['按付款日期统计', '金额统一保留两位小数'],
      },
      { channel: 'web', userId: 'owner', sessionId: 's1' },
    ) as { ok: boolean; contract: { version: number }; savedMemoryId?: string }

    expect(amendResult.ok).toBe(true)
    expect(amendResult.contract.version).toBe(2)
    expect(amendResult.savedMemoryId).toBeTruthy()

    // 验证旧版本口径和旧运行记录快照都完好保留
    const v1History = contracts.getVersion(c1.id, 1)!
    expect(v1History.assumptions).toContain('默认统计日期口径为订单创建日期')
    const run1Snapshot = scheduler.getRunContractSnapshot(run1.id) as { version: number; assumptions: string[] }
    expect(run1Snapshot.version).toBe(1)
    expect(run1Snapshot.assumptions).toContain('默认统计日期口径为订单创建日期')
    // 第 1 周工单自己的合同也保留 v1 口径
    const ticket1Contract = contracts.get('ticket', run1.ticketId!)!
    expect(ticket1Contract.assumptions).toContain('默认统计日期口径为订单创建日期')

    // 长期记忆中已沉淀了可召回的新约定
    const memHit = memories.recall({ query: '销售周报 付款日期 两位小数', projectId: 'p_sales', limit: 5 })
    expect(memHit.some(m => m.id === amendResult.savedMemoryId)).toBe(true)

    // 3. 第 2 周自动执行：无需用户重复说明，自动采用 v2 新口径！
    const run2 = await scheduler.runNow(sch.id)
    expect(run2.contractVersion).toBe(2)
    expect(dispatched[1]!.text).toContain('付款日期')
    expect(dispatched[1]!.text).toContain('保留两位小数')
    const ticket2Contract = contracts.get('ticket', run2.ticketId!)!
    expect(ticket2Contract.criteria.some(c => c.text.includes('两位小数'))).toBe(true)

    // 模拟第 2 周工单执行失败且未通过验收 → 验证三态独立记录（已派发，但执行失败、验收未通过）
    const settled2 = scheduler.onTicketSettled(run2.ticketId!, 'closed', 'unmet')!
    expect(settled2.dispatchStatus).toBe('dispatched')
    expect(settled2.executionStatus).toBe('failed')
    expect(settled2.acceptanceStatus).toBe('failed')
    db.close()
  })

  it('真实 Runtime HTTP 入口：/api/contracts、/api/tickets/:id/evidences 与 /api/tickets/:id/receipt 全链路打通', async () => {
    const stateDir = tempDir('sa-stage1-rt-')
    const cfg = parseConfig({
      stateDir,
      maxSlots: 2,
      operatorId: 'operator',
      launcher: { command: process.execPath, args: [FAKE_PI], env: { FAKE_PI_REPORT_READY: '1', FAKE_PI_RUN_MS: '20' } },
      policy: { policy: { sources: { cli: { allowed: [{ id: 'operator', name: 'Operator' }] } } }, eval: { mode: 'auto' } },
    })
    const rt = await createRuntime(cfg)
    try {
      const cliToken = readFileSync(join(stateDir, 'cli-token'), 'utf8').trim()
      const headers = {
        authorization: `Bearer ${cliToken}`,
        'content-type': 'application/json',
      }

      // 确认 contracts 插件已注册启用
      const plugRes = await fetch(`${rt.adminUrl}/api/plugins`, { headers })
      expect(plugRes.status).toBe(200)
      const plugBody = await plugRes.json() as { items: { id: string; enabled: boolean }[] }
      expect(plugBody.items.some(p => p.id === 'contracts' && p.enabled)).toBe(true)

      // 通过 HTTP 创建带合同的工单并拉取回执
      const created = await rt.ask('整理本周销售报表')
      expect(created.ticketId).toBeTruthy()
      const tid = created.ticketId!

      const ctrRes = await fetch(`${rt.adminUrl}/api/contracts/ticket/${tid}`, { headers })
      expect(ctrRes.status).toBe(200)
      const ctrBody = await ctrRes.json() as { item: { version: number }; versions: unknown[] }
      expect(ctrBody.item.version).toBe(1)
      expect(ctrBody.versions).toHaveLength(1)

      // 中途修订合同（scope=preference）
      const amendRes = await fetch(`${rt.adminUrl}/api/contracts/ticket/${tid}/amend`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          scope: 'preference',
          reason: '以后所有金额严格保留两位小数',
          criteria: [{ id: 'c_fmt', text: '金额保留两位小数', required: true }],
        }),
      })
      expect(amendRes.status).toBe(200)
      const amendBody = await amendRes.json() as { contract: { version: number }; savedMemoryId?: string }
      expect(amendBody.contract.version).toBe(2)
      expect(amendBody.savedMemoryId).toBeTruthy()

      // 登记客观证据并读取交付回执
      const evRes = await fetch(`${rt.adminUrl}/api/tickets/${tid}/evidences`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          kind: 'data',
          criterionId: 'c_fmt',
          runId: 'run_check_1',
          artifactVersion: 'v2-csv',
          passed: true,
          summary: '校验通过：全部 42 笔金额均保留两位小数',
        }),
      })
      expect(evRes.status).toBe(200)

      const recRes = await fetch(`${rt.adminUrl}/api/tickets/${tid}/receipt`, { headers })
      expect(recRes.status).toBe(200)
      const recBody = await recRes.json() as {
        receipt: { status: string; contractVersion: number; criteria: { id: string; status: string }[] }
      }
      expect(recBody.receipt.contractVersion).toBe(2)
      expect(recBody.receipt.status).toBe('verified')
      expect(recBody.receipt.criteria[0]).toMatchObject({ id: 'c_fmt', status: 'passed' })
    } finally {
      await rt.stop('test')
    }
  })
})
