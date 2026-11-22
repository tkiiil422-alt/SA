/**
 * 最终端到端交付验收测试（真实 Runtime + 真实 HTTP 控制台入口）：
 * 1. 端到端任务 A — 网页改动（Git worktree 并发分支 → 修改表单应用并新增文件 → browser_verify 提交刷新持久化
 *    → Diff 行级审查批注/返工/签核 → 合并回主分支 → 最终交付回执验证）。
 * 2. 端到端任务 B — 周期性销售周报（创建周五定时任务 → v1 运行保留旧口径 → 中途纠正“按付款日期+两位小数”更新约定与记忆
 *    → 下周 v2 自动沿用新口径 → 零 Token 注册脚本核对真实 CSV 数据并回填证据 → 交付回执与三态调度记录验收）。
 * 3. 插件热停用真实 HTTP 验证（停用后 `/api/remote/nodes` 立即退出返回 404，重新启用恢复 200）。
 */
import { execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { createRuntime, type Runtime } from '../src/runtime.ts'
import { parseConfig } from '../src/config.ts'

const FAKE_PI = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-pi.mjs')

const dirs: string[] = []
const runtimes: Runtime[] = []

function tempDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(d)
  return d
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim()
}

afterEach(async () => {
  for (const rt of runtimes.splice(0)) await rt.stop('e2e-test')
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('V2 最终端到端业务验收（网页改动 + 周期周报）', () => {
  it('完整端到端演示：网页改动 + 周期周报 + 插件热停用全链路验收', async () => {
    const root = tempDir('sa-e2e-v2-')
    const stateDir = join(root, 'state')
    const wsRoot = join(root, 'workspaces')
    const projRoot = join(root, 'projects')
    process.env.SA_WORKSPACE_ROOT = wsRoot
    process.env.SA_PROJECTS_ROOT = projRoot

    const rt = await createRuntime(parseConfig({
      stateDir,
      maxSlots: 2,
      operatorId: 'operator',
      launcher: {
        command: process.execPath,
        args: [FAKE_PI],
        env: { FAKE_PI_REPORT_READY: '1', FAKE_PI_RUN_MS: '30' },
      },
      policy: {
        policy: { sources: { cli: { allowed: [{ id: 'operator', name: 'Operator' }] } } },
        eval: { mode: 'auto' },
      },
    }))
    runtimes.push(rt)

    const token = readFileSync(join(stateDir, 'cli-token'), 'utf8').trim()
    const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
    const api = async (path: string, init: RequestInit = {}) => {
      const resp = await fetch(`${rt.adminUrl}/api${path}`, { ...init, headers: { ...headers, ...(init.headers ?? {}) } })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const body = (await resp.json().catch(() => ({}))) as any
      return { status: resp.status, body }
    }

    // =========================================================================
    // 端到端任务 1：网页改动（Git worktree → browser_verify → Diff 审查/批注/返工/合并 → 交付回执）
    // =========================================================================
    const srcRepo = join(projRoot, '.imports', 'mini-webapp')
    mkdirSync(srcRepo, { recursive: true })
    writeFileSync(join(srcRepo, 'index.html'), '<h1>待办清单 v1</h1>\n', 'utf8')
    git(srcRepo, 'init', '-b', 'main')
    git(srcRepo, '-c', 'user.name=Dev', '-c', 'user.email=dev@local', 'add', '-A')
    git(srcRepo, '-c', 'user.name=Dev', '-c', 'user.email=dev@local', 'commit', '-m', 'init webapp')

    const importRes = await api('/projects/import', {
      method: 'POST',
      body: JSON.stringify({ path: srcRepo, name: 'MiniWebApp' }),
    })
    expect(importRes.status).toBe(200)
    const projectId = importRes.body.projectId as string

    // 通过真实 HTTP API 发单（worktree 模式 + 结构化验收条件）
    const webTicketRes = await api('/tickets', {
      method: 'POST',
      body: JSON.stringify({
        text: '升级 MiniWebApp 页面，增加可持久化提交的待办表单并通过浏览器自检',
        projectId,
        projectMode: 'worktree',
        goal: {
          text: '表单提交后刷新页面仍保留数据，且新增页面说明文件',
          mode: 'commands',
          commands: ['node -e "process.exit(0)"'],
          criteria: [{ id: 'c_web_persist', text: '提交表单刷新后数据仍在', required: true }],
        },
      }),
    })
    expect(webTicketRes.status).toBe(200)
    const webTid = webTicketRes.body.ticketId as string
    expect(webTid).toBeTruthy()

    // 等待 worktree 目录准备完成
    const wtDir = join(wsRoot, webTid, 'project')
    for (let i = 0; i < 40 && !existsSync(join(wtDir, 'index.html')); i += 1) {
      await new Promise(r => setTimeout(r, 50))
    }
    expect(existsSync(join(wtDir, 'index.html'))).toBe(true)

    // 模拟在 worktree 分支完成页面代码修改 + 新增未追踪说明文档 + 写交付文件
    writeFileSync(join(wtDir, 'index.html'), '<h1>待办清单 v2（已支持持久化）</h1>\n', 'utf8')
    writeFileSync(join(wtDir, 'CHANGELOG.md'), '# 变更日志\n- 新增表单持久化能力\n', 'utf8')
    mkdirSync(join(wsRoot, webTid, 'output'), { recursive: true })
    writeFileSync(join(wsRoot, webTid, 'output', 'webapp-report.md'), '# 网页改动交付说明\n已验证表单提交刷新持久化。\n', 'utf8')

    // 启动改动后的本地表单 Web 应用并用真实 HTTP `/api/tickets/:id/browser-verify` 自检
    let persistedTodo = ''
    const webSrv = createServer((req, res) => {
      if (req.method === 'POST' && req.url === '/todo') {
        let raw = ''
        req.on('data', c => { raw += String(c) })
        req.on('end', () => {
          persistedTodo = new URLSearchParams(raw).get('item') ?? ''
          res.writeHead(303, { location: '/' })
          res.end()
        })
        return
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(`<!doctype html><html><body>
        <h1>待办清单 v2</h1>
        <form method="POST" action="/todo"><input name="item" value="${persistedTodo}" /><button type="submit">保存</button></form>
        <p id="saved">${persistedTodo}</p>
      </body></html>`)
    })
    await new Promise<void>(r => webSrv.listen(0, '127.0.0.1', () => r()))
    const webPort = (webSrv.address() as { port: number }).port
    try {
      const bvRes = await api(`/tickets/${webTid}/browser-verify`, {
        method: 'POST',
        body: JSON.stringify({
          url: `http://127.0.0.1:${webPort}/`,
          criterionId: 'c_web_persist',
          artifactVersion: 'webapp-v2',
          preferPlaywright: false,
          steps: [
            { action: 'fill', name: 'item', value: '完成端到端验收' },
            { action: 'submit' },
            { action: 'reload' },
            { action: 'assertText', text: '完成端到端验收' },
            { action: 'assertValue', name: 'item', value: '完成端到端验收' },
          ],
        }),
      })
      expect(bvRes.status).toBe(200)
      expect(bvRes.body.ok).toBe(true)
    } finally {
      await new Promise<void>(r => webSrv.close(() => r()))
    }

    // 审查 Diff（含未追踪新增文件 CHANGELOG.md）→ 添加行级批注 → 返工修正 → 签核通过 → 合并回主分支！
    const diffRes = await api(`/tickets/${webTid}/diff`)
    expect(diffRes.status).toBe(200)
    expect(diffRes.body.available).toBe(true)
    expect(diffRes.body.diff).toContain('+++ b/CHANGELOG.md')

    const cmtRes = await api(`/tickets/${webTid}/review`, {
      method: 'POST',
      body: JSON.stringify({ action: 'comment', file: 'CHANGELOG.md', line: 2, comment: '补充版本号 v2.0' }),
    })
    expect(cmtRes.status).toBe(200)
    // 模拟根据批注修改后重新签核通过
    writeFileSync(join(wtDir, 'CHANGELOG.md'), '# 变更日志 v2.0\n- 新增表单持久化能力与 browser_verify 验收\n', 'utf8')
    const approveRes = await api(`/tickets/${webTid}/review`, {
      method: 'POST',
      body: JSON.stringify({ action: 'approve', note: '已复审通过' }),
    })
    expect(approveRes.status).toBe(200)

    const mergeRes = await api(`/tickets/${webTid}/merge`, {
      method: 'POST',
      body: JSON.stringify({ mode: 'merge' }),
    })
    expect(mergeRes.status).toBe(200)
    expect(mergeRes.body.ok).toBe(true)
    // 确认项目主树已拿到合并后的最新代码与新增文件
    expect(readFileSync(join(projRoot, projectId, 'tree', 'CHANGELOG.md'), 'utf8')).toContain('v2.0')

    // 拉取工单最终交付回执：一键核对交付物 + 逐项验收证据
    const webReceiptRes = await api(`/tickets/${webTid}/receipt`)
    expect(webReceiptRes.status).toBe(200)
    expect(webReceiptRes.body.receipt.status).toBe('verified')
    expect(webReceiptRes.body.receipt.criteria[0]).toMatchObject({ id: 'c_web_persist', status: 'passed' })
    expect(webReceiptRes.body.receipt.evidences.some((e: { kind: string; passed: boolean }) => e.kind === 'browser' && e.passed)).toBe(true)
    expect(webReceiptRes.body.receipt.deliverables.some((d: { path: string }) => d.path.includes('webapp-report.md'))).toBe(true)

    // =========================================================================
    // 端到端任务 2：周期性销售周报（v1 运行 → 纠正口径升级 v2 & 记入长期记忆 → 下周 v2 + 0 Token 脚本核对）
    // =========================================================================
    const schRes = await api('/schedules', {
      method: 'POST',
      body: JSON.stringify({
        name: '每周五销售周报',
        triggerKind: 'cron',
        cronExpr: '0 17 * * 5',
        actionKind: 'dispatch_ticket',
        actionConfig: { prompt: '整理本周销售周报并核对总销售额' },
      }),
    })
    expect(schRes.status).toBe(200)
    const schId = schRes.body.item.id as string

    // 设定 v1 初始任务约定
    const ctr1 = await api(`/contracts/schedule/${schId}`, {
      method: 'PUT',
      body: JSON.stringify({
        goal: '每周五整理销售周报',
        deliverables: ['output/sales-report.md'],
        criteria: [{ id: 'c_sales', text: '汇总本周销售额（v1 默认按创建日期）', required: true }],
        assumptions: ['按订单创建日期统计'],
      }),
    })
    expect(ctr1.status).toBe(200)
    expect(ctr1.body.item.version).toBe(1)

    // 第 1 周运行
    const run1Res = await api(`/schedules/${schId}/run`, { method: 'POST', body: '{}' })
    expect(run1Res.status).toBe(200)
    expect(run1Res.body.run.contractVersion).toBe(1)
    expect(run1Res.body.run.dispatchStatus).toBe('dispatched')

    // 用户纠正：“以后按付款日期，金额保留两位小数”
    const amendRes = await api(`/contracts/schedule/${schId}/amend`, {
      method: 'POST',
      body: JSON.stringify({
        scope: 'preference',
        reason: '以后按付款日期统计，金额严格保留两位小数',
        criteria: [{ id: 'c_sales_paid', text: '按付款日期归集，全部金额保留两位小数', required: true }],
        assumptions: ['按付款日期(paid_at)统计', '所有金额保留两位小数'],
      }),
    })
    expect(amendRes.status).toBe(200)
    expect(amendRes.body.contract.version).toBe(2)

    // 验证长期记忆已自动沉淀且可召回
    const recallRes = await api('/memories/recall?q=' + encodeURIComponent('销售周报 付款日期 两位小数'))
    expect(recallRes.status).toBe(200)
    expect(recallRes.body.items.length).toBeGreaterThan(0)

    // 下周运行：自动使用 v2 口径，无需用户重复说明
    const run2Res = await api(`/schedules/${schId}/run`, { method: 'POST', body: '{}' })
    expect(run2Res.status).toBe(200)
    expect(run2Res.body.run.contractVersion).toBe(2)
    const salesTid2 = run2Res.body.run.ticketId as string
    expect(salesTid2).toBeTruthy()

    // 在第 2 周工单工作区放入真实销售 CSV，并通过 0 Token 注册脚本 `sales-report-check` 核对并回填证据
    mkdirSync(join(wsRoot, salesTid2), { recursive: true })
    writeFileSync(
      join(wsRoot, salesTid2, 'orders.csv'),
      'order_id,created_at,paid_at,channel,amount\n101,2026-11-18,2026-11-20,线上,199.90\n102,2026-11-19,2026-11-21,门店,300.10\n103,2026-11-20,,线上,88.00\n',
      'utf8',
    )
    const runnerRes = await api('/runners/run', {
      method: 'POST',
      body: JSON.stringify({
        runnerId: 'script',
        ticketId: salesTid2,
        scriptId: 'sales-report-check',
        scriptParams: { inputFile: 'orders.csv', dateField: 'paid_at', decimals: 2 },
        criterionId: 'c_sales_paid',
      }),
    })
    expect(runnerRes.status).toBe(200)
    expect(runnerRes.body.ok).toBe(true)
    expect(runnerRes.body.result.costUsd).toBe(0)
    expect(runnerRes.body.result.data.totalFormatted).toBe('500.00')

    // 检查第 2 周工单交付回执：明确展示 0 Token 数据核对证据与已通过的验收条件
    const salesReceiptRes = await api(`/tickets/${salesTid2}/receipt`)
    expect(salesReceiptRes.status).toBe(200)
    expect(salesReceiptRes.body.receipt.status).toBe('verified')
    expect(salesReceiptRes.body.receipt.criteria[0]).toMatchObject({ id: 'c_sales_paid', status: 'passed' })
    expect(salesReceiptRes.body.receipt.evidences.some((e: { kind: string; summary: string }) => e.kind === 'data' && e.summary.includes('500.00'))).toBe(true)

    // 核对调度运行历史保留两次独立版本（v1 与 v2）与三态字段
    const runsListRes = await api(`/schedules/${schId}/runs`)
    expect(runsListRes.status).toBe(200)
    const versions = (runsListRes.body.items as { contractVersion: number }[]).map(r => r.contractVersion)
    expect(versions).toContain(1)
    expect(versions).toContain(2)

    // =========================================================================
    // 架构约束真实 HTTP 实测：
    // 1) 单机模式默认停用 remote-nodes（404），按需启用后 200，再停用恢复 404；
    // 2) 热停用 evolution 插件后路由立即 404，重新启用恢复 200。
    // =========================================================================
    expect((await api('/remote/nodes')).status).toBe(404)
    const remoteOn = await api('/plugins/remote-nodes', { method: 'PUT', body: JSON.stringify({ enabled: true }) })
    expect(remoteOn.status).toBe(200)
    expect((await api('/remote/nodes')).status).toBe(200)
    const remoteOff = await api('/plugins/remote-nodes', { method: 'PUT', body: JSON.stringify({ enabled: false }) })
    expect(remoteOff.status).toBe(200)
    expect((await api('/remote/nodes')).status).toBe(404)

    expect((await api('/evolution/benchmarks')).status).toBe(200)
    const offRes = await api('/plugins/evolution', { method: 'PUT', body: JSON.stringify({ enabled: false }) })
    expect(offRes.status).toBe(200)
    expect(offRes.body.item.enabled).toBe(false)
    expect((await api('/evolution/benchmarks')).status).toBe(404)

    const onRes = await api('/plugins/evolution', { method: 'PUT', body: JSON.stringify({ enabled: true }) })
    expect(onRes.status).toBe(200)
    expect((await api('/evolution/benchmarks')).status).toBe(200)
  }, 45_000)
})
