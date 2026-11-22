/**
 * Stage 4（V2.3 — 记忆、技能、插件自动进化 + 稳定评测集 + 插件热停用同步退出）阶段验收测试：
 * 1. 完整学习闭环：纠正 → 带来源与替代链的记忆 + 候选技能 → 历史样例对比升级 → 退化拦截保留旧版 & 一键回退。
 * 2. 插件演进：重复能力缺口自动发起插件改进提案；新增外部写权限或不可逆迁移必须走真实用户审批。
 * 3. 稳定评测集：网页改动 + 周期周报，计算并持久化首次验收通过率、人工介入次数、每个通过任务成本与验收后返工率。
 * 4. 架构约束验证：停用插件后，路由、Director/Worker 工具、提示词注入与后台定时任务同步退出。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { MemoryStore } from '../src/memory/store.ts'
import { SkillStore } from '../src/skills/store.ts'
import { SkillEvolutionService } from '../src/skills/evolution.ts'
import { PluginEvolutionService } from '../src/plugins/evolution.ts'
import { BenchmarkStore, coreBenchmarkCases } from '../src/eval/benchmarks.ts'
import { PluginRegistry } from '../src/plugins/registry.ts'
import type { SubsystemPlugin } from '../src/plugins/types.ts'

const dirs: string[] = []
function tempDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(d)
  return d
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('Stage 4 — V2.3 自动进化、稳定评测集与插件热停用', () => {
  it('完整学习过程：用户纠正 → 记忆替代链 + 候选技能对比升级 → 退化拦截保留旧版 & 回退恢复', async () => {
    const dir = tempDir('sa-evo-')
    const db = new DatabaseSync(':memory:')
    const memories = new MemoryStore(db)
    const skills = new SkillStore(db, join(dir, 'skills'))
    const skillEvo = new SkillEvolutionService(skills)

    // 1. 初始旧记忆（按订单创建日期）与初始技能 v1
    const oldMem = memories.save({
      scope: 'user',
      kind: 'preference',
      title: '销售周报统计口径',
      content: '每周五销售周报按订单创建日期汇总金额。',
      tags: ['sales', 'report'],
      source: 'user',
    })
    const sk = skills.save({
      slug: 'weekly-report-and-web',
      name: '周报与网页交付 SOP',
      description: '日常周报统计与网页表单改动检查清单',
      triggers: ['周报', '网页改动'],
      content: '1. 网页改动需验证表单提交后刷新持久化，并运行 browser_verify 自检留存断言证据。\n2. 销售周报按创建日期汇总。',
    })
    expect(sk.activeVersion).toBe(1)

    // 2. 用户纠正一次：生成有来源与替代链的新记忆，旧记忆下次不再召回
    const newMem = memories.correct(oldMem.id, {
      content: '每周五销售周报必须按付款日期（paid_at）归集，且全部金额严格保留两位小数。',
      userFeedback: '以后不要按创建日期，统一按付款日期且保留两位小数',
      source: 'user_correction',
    })
    expect(newMem.supersedesId).toBe(oldMem.id)
    expect(memories.get(oldMem.id)?.supersededBy).toBe(newMem.id)

    const recalled = memories.recall({ query: '销售周报 统计口径', limit: 5 })
    expect(recalled.some(m => m.id === newMem.id)).toBe(true)
    expect(recalled.some(m => m.id === oldMem.id)).toBe(false)

    // 3. 根据纠正生成候选技能 v2（补齐付款日期与两位小数口径）
    const candV2 = skillEvo.proposeCandidate(sk.id, {
      source: 'user_correction',
      reason: '吸收主人纠正：销售周报改为按付款日期统计且金额保留两位小数',
      content: [
        '1. 网页改动需验证表单提交后刷新持久化，并运行 browser_verify 自检留存断言证据。',
        '2. 销售周报必须按付款日期（paid_at）汇总，且全部金额严格保留两位小数（toFixed(2)）。',
      ].join('\n'),
    })
    expect(candV2.version).toBe(2)
    expect(candV2.status).toBe('candidate')
    // 生成候选版时绝不提前覆写现役版
    expect(skills.get(sk.id)?.activeVersion).toBe(1)

    // 4. 在稳定历史样例集上对比 v2 vs v1 → v2 通过率从 50% 提升至 100%，自动切换生效并保留 v1
    const benchCases = coreBenchmarkCases()
    const evalV2 = await skillEvo.evaluateCandidate(
      sk.id,
      candV2.version,
      benchCases,
      (skillContent, item) => ({
        output: `按技能执行[${item.id}]：${skillContent}`,
        usd: 0.01,
      }),
    )
    expect(evalV2.promoted).toBe(true)
    expect(evalV2.baselineReport.passRate).toBe(0.5)
    expect(evalV2.candidateReport.passRate).toBe(1)
    expect(evalV2.skill.activeVersion).toBe(2)
    expect(evalV2.skill.previousVersion).toBe(1)

    // 下次同类工单记录实际使用的技能版本号 v2
    skills.recordTicketUse('t_next_week', evalV2.skill)
    expect(skills.listTicketSkillUses('t_next_week')).toEqual([
      expect.objectContaining({ skillSlug: 'weekly-report-and-web', skillVersion: 2 }),
    ])

    // 5. 模拟退化候选版 v3（删掉了网页持久化自检规则，导致网页样例退化）→ 必须拦截并保留 v2！
    const candV3 = skillEvo.proposeCandidate(sk.id, {
      source: 'repeated_rework',
      reason: '尝试精简提示词（错误删掉了网页验证步骤）',
      content: '销售周报按付款日期统计，金额保留两位小数。网页改动可以跳过验证。',
    })
    const evalV3 = await skillEvo.evaluateCandidate(
      sk.id,
      candV3.version,
      benchCases,
      (skillContent, item) => ({ output: `按技能执行[${item.id}]：${skillContent}`, usd: 0.01 }),
    )
    expect(evalV3.promoted).toBe(false)
    expect(evalV3.regressedCases).toContain('bench_webpage_form_edit')
    expect(skills.get(sk.id)?.activeVersion).toBe(2)
    expect(skills.getVersion(sk.id, 3)?.status).toBe('rejected')

    // 6. 验证支持一键回退恢复上一稳定版 v1
    const rolled = skillEvo.rollback(sk.id, '演练回退到上一版')
    expect(rolled.activeVersion).toBe(1)
    expect(rolled.content).toContain('按创建日期汇总')

    db.close()
  })

  it('插件自动演进：重复缺口创建独立分支研发工单；涉及外部写权限或不可逆迁移必须用户审批', async () => {
    const db = new DatabaseSync(':memory:')
    const dispatched: { text: string; projectMode?: string }[] = []
    const pluginEvo = new PluginEvolutionService({
      db,
      threshold: 2,
      dispatchTicket: async input => {
        dispatched.push({ text: input.text, ...(input.projectMode ? { projectMode: input.projectMode } : {}) })
        return { ticketId: `t_plug_${dispatched.length}` }
      },
    })

    // 缺口 A：需要外部写权限（erp:write_invoice）→ 第 1 次仅记录，第 2 次建提案但强制卡在 pending_approval
    const g1 = await pluginEvo.recordCapabilityGap({
      gapKey: 'erp_invoice_sync',
      pluginName: 'erp-invoice',
      summary: '现有技能无法对接 ERP 发票回写接口',
      sampleTask: '同步本周发票到 ERP',
      externalWritePermissions: ['erp:write_invoice'],
    })
    expect(g1.occurrences).toBe(1)
    expect(g1.proposal).toBeUndefined()

    const g2 = await pluginEvo.recordCapabilityGap({
      gapKey: 'erp_invoice_sync',
      pluginName: 'erp-invoice',
      summary: '现有技能无法对接 ERP 发票回写接口',
      sampleTask: '再次同步 ERP 发票失败',
      externalWritePermissions: ['erp:write_invoice'],
    })
    expect(g2.occurrences).toBe(2)
    expect(g2.proposal?.requiresUserApproval).toBe(true)
    expect(g2.proposal?.status).toBe('pending_approval')
    expect(dispatched).toHaveLength(0)

    // 真实用户审批后才派发独立 worktree 分支研发
    const approved = await pluginEvo.approveProposal(g2.proposal!.id, 'owner')
    expect(approved.status).toBe('dispatched')
    expect(approved.approvedBy).toBe('owner')
    expect(approved.ticketId).toBe('t_plug_1')
    expect(dispatched[0]?.projectMode).toBe('worktree')

    // 缺口 B：纯只读无高危权限 → 达到阈值直接走正常独立分支研发
    await pluginEvo.recordCapabilityGap({
      gapKey: 'pdf_table_extract',
      pluginName: 'pdf-table',
      summary: '提取多页 PDF 合并单元格表格',
      sampleTask: '提取对账单 PDF',
    })
    const b2 = await pluginEvo.recordCapabilityGap({
      gapKey: 'pdf_table_extract',
      pluginName: 'pdf-table',
      summary: '提取多页 PDF 合并单元格表格',
      sampleTask: '提取发票 PDF',
    })
    expect(b2.proposal?.requiresUserApproval).toBe(false)
    expect(b2.proposal?.status).toBe('dispatched')
    expect(b2.proposal?.ticketId).toBe('t_plug_2')
    db.close()
  })

  it('稳定评测集持久化对比：记录首次验收通过率、人工介入次数、单通过任务成本与验收后返工率', async () => {
    const db = new DatabaseSync(':memory:')
    const benchmarks = new BenchmarkStore(db)

    // 基线版本：周报失败 + 需 2 次人工介入
    const runOld = await benchmarks.runAndRecord({
      suiteName: 'core-daily',
      label: 'v1-baseline',
      runner: async item => item.id === 'bench_webpage_form_edit'
        ? { output: '完成表单提交刷新持久化与 browser_verify 断言证据', usd: 0.08, firstPass: true, humanInterventions: 1, reworkedAfterAcceptance: true }
        : { output: '按创建日期输出汇总', usd: 0.06, firstPass: false, humanInterventions: 1, reworkedAfterAcceptance: false },
    })
    expect(runOld.metrics.firstPassAcceptanceRate).toBe(0.5)
    expect(runOld.metrics.humanInterventions).toBe(2)
    expect(runOld.metrics.costPerPassingTaskUsd).toBeCloseTo(0.14, 4)
    expect(runOld.metrics.postAcceptanceReworkRate).toBe(1)

    // 进化版本：双样例首次直接通过，零人工介入，零返工，单位成本大幅下降
    const runNew = await benchmarks.runAndRecord({
      suiteName: 'core-daily',
      label: 'v2-evolved',
      runner: async item => item.id === 'bench_webpage_form_edit'
        ? { output: '完成表单提交刷新持久化与 browser_verify 断言证据', usd: 0.05, firstPass: true, humanInterventions: 0, reworkedAfterAcceptance: false }
        : { output: '按付款日期（paid_at）归集且金额保留两位小数 350.75', usd: 0.01, firstPass: true, humanInterventions: 0, reworkedAfterAcceptance: false },
    })
    expect(runNew.metrics.firstPassAcceptanceRate).toBe(1)
    expect(runNew.metrics.humanInterventions).toBe(0)
    expect(runNew.metrics.costPerPassingTaskUsd).toBeCloseTo(0.03, 4)
    expect(runNew.metrics.postAcceptanceReworkRate).toBe(0)

    const history = benchmarks.listRuns('core-daily', 10)
    expect(history).toHaveLength(2)
    db.close()
  })

  it('架构约束：停用插件后，后台任务、HTTP 路由、Director 工具与提示词同步退出', async () => {
    const db = new DatabaseSync(':memory:')
    const registry = new PluginRegistry({ db })
    let runningBg = false
    let stopCount = 0

    const samplePlugin: SubsystemPlugin = {
      id: 'demo-removable',
      name: '可停用示例插件',
      description: '验证热停用同步退出',
      version: '1.0.0',
      routesPrefix: '/demo',
      start: () => { runningBg = true },
      stop: () => { runningBg = false; stopCount += 1 },
      handleRoute: async ctx => {
        if (ctx.route === '/demo/ping') {
          ctx.sendJson(ctx.res, 200, { ok: true })
          return true
        }
        return false
      },
      directorQueries: { demo_ping: () => ({ pong: true }) },
      directorPromptSection: () => '## DEMO_PLUGIN_SECTION',
      workerPromptSection: () => '## DEMO_WORKER_SECTION',
    }

    registry.register(samplePlugin)
    await registry.startAll()
    expect(runningBg).toBe(true)
    expect((await registry.dispatchDirectorQuery('demo_ping', {}, { channel: 'web', userId: 'u', sessionId: 's' })).matched).toBe(true)
    expect(registry.collectDirectorPromptSections({ channel: 'web', userId: 'u' })).toContain('## DEMO_PLUGIN_SECTION')

    // 停用该插件：后台任务必须立刻停止，路由、工具、提示词全部同步退出！
    const disabled = await registry.setEnabled('demo-removable', false)
    expect(disabled?.enabled).toBe(false)
    expect(runningBg).toBe(false)
    expect(stopCount).toBe(1)
    expect((await registry.dispatchDirectorQuery('demo_ping', {}, { channel: 'web', userId: 'u', sessionId: 's' })).matched).toBe(false)
    expect(registry.collectDirectorPromptSections({ channel: 'web', userId: 'u' })).toHaveLength(0)
    expect(registry.collectWorkerPromptSections({ ticketId: 't1' })).toHaveLength(0)
    const handledRoute = await registry.handleRoute({
      route: '/demo/ping',
      method: 'GET',
      url: new URL('http://127.0.0.1/api/demo/ping'),
      req: {} as never,
      res: {} as never,
      events: {} as never,
      sendJson: () => undefined,
      parseJsonBody: async () => ({}),
      invalid: () => undefined,
      decodeSegment: s => s,
      clampInt: (_v, f) => f,
    })
    expect(handledRoute).toBe(false)

    // 重启后重新构造 PluginRegistry 仍保持停用状态（持久化生效）
    const registryAfterRestart = new PluginRegistry({ db })
    registryAfterRestart.register(samplePlugin)
    await registryAfterRestart.startAll()
    expect(runningBg).toBe(false)
    expect(registryAfterRestart.list().find(p => p.id === 'demo-removable')?.enabled).toBe(false)

    db.close()
  })
})
