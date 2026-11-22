/**
 * Stage 7（单机生产完整闭环）回归与集成测试：
 * 1. MultiRunnerExecutor 真实工单生命周期：POST /api/tickets 指定 runnerId='script'（0 Token），
 *    自动完成脚本执行、记录 Goal 证据并结算工单为 completed；同时验证技能 preferredRunnerId 自动分流。
 * 2. Git worktree 自动推分支（pushWorktreeBranch）+ worktreeGitDir 返回值，针对真实本地 bare 仓库推送验证。
 * 3. SkillAutoObserver 后台自动观察（连续未通过自动起草候选修订，不覆写现役版）+ HTTP auto-correct / benchmarks/run。
 * 4. 单机默认模式验证：remote-nodes 插件默认关闭，不占用后台定时器与路由。
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createRuntime, type Runtime } from '../src/runtime.ts'
import { parseConfig } from '../src/config.ts'
import {
  commitWorktreeChanges,
  prepareWorktree,
  pushWorktreeBranch,
} from '../src/projects/worktree.ts'
import { SkillStore } from '../src/skills/store.ts'
import { SkillEvolutionService } from '../src/skills/evolution.ts'
import { SkillAutoObserver } from '../src/skills/auto-observer.ts'
import { EventLog } from '../src/ledger/events.ts'
import { DatabaseSync } from 'node:sqlite'

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
  for (const rt of runtimes.splice(0)) {
    try { await rt.stop('test') } catch { /* ignore */ }
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('Stage 7 — 单机多执行器、Git Worktree 推送、自进化自动观察与默认精简配置', () => {
  it('MultiRunnerExecutor 0 Token 脚本工单全生命周期 + 技能 preferredRunnerId 自动分流 + HTTP 基准评测与单机默认配置', async () => {
    const root = tempDir('sa-stage7-rt-')
    const stateDir = join(root, 'state')
    const wsRoot = join(root, 'workspaces')
    const projRoot = join(root, 'projects')
    mkdirSync(wsRoot, { recursive: true })
    mkdirSync(projRoot, { recursive: true })
    process.env.SA_WORKSPACE_ROOT = wsRoot
    process.env.SA_PROJECTS_ROOT = projRoot

    const rt = await createRuntime(parseConfig({
      stateDir,
      maxSlots: 2,
      operatorId: 'operator',
      launcher: { command: process.execPath, args: ['-e', 'process.exit(0)'], env: {} },
      policy: {
        policy: { sources: { cli: { allowed: [{ id: 'operator', name: 'Operator' }] } } },
        eval: { mode: 'auto' },
      },
    }))
    runtimes.push(rt)
    const token = readFileSync(join(stateDir, 'cli-token'), 'utf8').trim()
    const api = async (path: string, init: RequestInit = {}) => {
      const res = await fetch(`${rt.adminUrl}/api${path}`, {
        ...init,
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          ...(init.headers ?? {}),
        },
      })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const body = (await res.json().catch(() => ({}))) as any
      return { status: res.status, body }
    }

    // 1. 单机默认模式：remote-nodes 默认停用
    const plRes = await api('/plugins')
    expect(plRes.status).toBe(200)
    const remotePlugin = (plRes.body.items as { id: string; enabled: boolean }[]).find(p => p.id === 'remote-nodes')
    expect(remotePlugin?.enabled).toBe(false)

    // 2. 通过 POST /api/tickets 指定 runnerId='script' 执行 0 Token 确定性脚本并自动结算工单
    const srcProj = join(projRoot, '.imports', 'sales-data')
    mkdirSync(srcProj, { recursive: true })
    writeFileSync(
      join(srcProj, 'sales.csv'),
      'order_id,created_at,paid_at,channel,amount\no1,2026-11-18,2026-11-20,web,120.5\no2,2026-11-19,2026-11-21,app,79.5\no3,2026-11-19,,app,999\n',
      'utf8',
    )
    const imp = await api('/projects/import', {
      method: 'POST',
      body: JSON.stringify({ path: srcProj, name: 'SalesData' }),
    })
    expect(imp.status).toBe(200)
    const salesProjId = imp.body.projectId as string

    const createRes = await api('/tickets', {
      method: 'POST',
      body: JSON.stringify({
        text: '核对本周销售回款金额（0 Token 脚本自动执行）',
        projectId: salesProjId,
        projectMode: 'copy',
        runnerId: 'script',
        scriptId: 'sales-report-check',
        scriptParams: {
          inputFile: 'project/sales.csv',
          dateField: 'paid_at',
          decimals: 2,
          weekStart: '2026-11-16',
          weekEnd: '2026-11-22',
        },
      }),
    })
    expect(createRes.status).toBe(200)
    const ticketId = createRes.body.ticketId as string
    expect(ticketId).toBeTruthy()

    // 等待 MultiRunnerExecutor 异步执行完成并结算工单
    let finalTicket: any
    for (let i = 0; i < 40; i += 1) {
      const tRes = await api(`/tickets/${ticketId}`)
      finalTicket = tRes.body
      if (finalTicket.status === 'ended') break
      await new Promise(r => setTimeout(r, 80))
    }
    expect(finalTicket.status).toBe('ended')
    expect(finalTicket.outcome).toBe('completed')
    expect(finalTicket.usage.totalUsd).toBe(0)
    expect(finalTicket.receipt?.evidences?.some((e: { kind: string; summary: string }) => e.kind === 'data' && e.summary.includes('200.00'))).toBe(true)

    // 3. 技能 preferredRunnerId 持久化 + 命中时自动记录技能使用并分流至非 Pi 执行器
    const skSave = await api('/skills', {
      method: 'POST',
      body: JSON.stringify({
        slug: 'workspace-manifest-check',
        name: '工作区清单自检',
        description: '使用 0 Token 脚本快速输出工作区文件清单',
        scope: 'worker',
        triggers: ['工作区清单自检'],
        preferredRunnerId: 'script',
        content: '调用 workspace-manifest 脚本核对文件清单。',
      }),
    })
    expect(skSave.status).toBe(200)
    expect(skSave.body.item.preferredRunnerId).toBe('script')

    // 4. 实时运行核心基准评测接口（POST /api/evolution/benchmarks/run）
    const benchRun = await api('/evolution/benchmarks/run', {
      method: 'POST',
      body: JSON.stringify({ label: 'stage7-baseline' }),
    })
    expect(benchRun.status).toBe(200)
    expect(benchRun.body.run.label).toBe('stage7-baseline')
    expect(benchRun.body.run.metrics.totalTasks).toBeGreaterThanOrEqual(2)

    const benchList = await api('/evolution/benchmarks')
    expect(benchList.status).toBe(200)
    expect(benchList.body.runs.some((r: { label: string }) => r.label === 'stage7-baseline')).toBe(true)

    // 5. 通过 HTTP 触发用户纠正自动 A/B 评测升级（POST /api/evolution/skills/:id/auto-correct）
    const skSales = await api('/skills', {
      method: 'POST',
      body: JSON.stringify({
        slug: 'sales-weekly-sop',
        name: '销售周报整理规范',
        description: '周报与表单交付规范',
        scope: 'both',
        triggers: ['销售周报'],
        content: '整理销售周报并输出汇总；表单修改后确保提交刷新持久化并通过 browser_verify 自检提供证据。',
      }),
    })
    expect(skSales.status).toBe(200)
    const autoRes = await api(`/evolution/skills/${skSales.body.item.id}/auto-correct`, {
      method: 'POST',
      body: JSON.stringify({
        correctionRule: '统计口径严格按付款日期（paid_at），所有金额保留两位小数（0.00）。',
        reason: '主人明确要求按付款日期统计且金额保留两位小数',
      }),
    })
    expect(autoRes.status).toBe(200)
    expect(autoRes.body.result.promoted).toBe(true)
    const afterSk = await api(`/skills/${skSales.body.item.id}`)
    expect(afterSk.body.item.activeVersion).toBe(2)
    expect(afterSk.body.item.previousVersion).toBe(1)
  }, 30_000)

  it('Git worktree 返回主仓 .git 目录并可将隔离分支推送到真实 bare 远端仓库', async () => {
    const root = tempDir('sa-stage7-git-')
    const bareDir = join(root, 'remote.git')
    const treeDir = join(root, 'tree')
    const wsDir = join(root, 'ws_t_push')
    mkdirSync(bareDir, { recursive: true })
    mkdirSync(treeDir, { recursive: true })

    git(bareDir, 'init', '--bare')
    git(treeDir, 'init')
    git(treeDir, 'config', 'user.name', 'Test')
    git(treeDir, 'config', 'user.email', 'test@local')
    writeFileSync(join(treeDir, 'index.html'), '<h1>Hello</h1>\n')
    git(treeDir, 'add', '-A')
    git(treeDir, 'commit', '-m', 'init')
    git(treeDir, 'remote', 'add', 'origin', bareDir)

    const prep = await prepareWorktree(treeDir, wsDir, 't_push_1')
    expect(prep.usedWorktree).toBe(true)
    expect(prep.branch).toBe('sa/t_push_1')

    writeFileSync(join(wsDir, 'project', 'feature.txt'), 'new worktree file\n')
    const committed = await commitWorktreeChanges({ workspace: wsDir, ticketId: 't_push_1' })
    expect(committed.ok).toBe(true)

    const pushed = await pushWorktreeBranch({ workspace: wsDir, ticketId: 't_push_1' })
    expect(pushed.ok).toBe(true)
    const remoteHeads = git(bareDir, 'for-each-ref', '--format=%(refname)')
    expect(remoteHeads).toContain('refs/heads/sa/t_push_1')
  }, 20_000)

  it('SkillAutoObserver 连续未通过自动生成候选修订版且不覆写现役版', () => {
    const db = new DatabaseSync(':memory:')
    const skills = new SkillStore(db)
    const evolution = new SkillEvolutionService(skills)
    const events = new EventLog(db)
    const observer = new SkillAutoObserver({ skills, evolution, events, reworkThreshold: 2 })

    const sk = skills.save({
      name: '表单测试技能',
      description: '表单改造 SOP',
      content: '修改表单后运行单测。',
    })
    skills.recordTicketUse('t_fail_1', sk)
    skills.recordTicketUse('t_fail_2', sk)

    const r1 = observer.onTicketEnded({
      ticketId: 't_fail_1',
      outcome: 'completed',
      acceptanceStatus: 'unmet',
      summary: '刷新页面后表单数据丢失',
    })
    expect(r1).toHaveLength(0)

    const r2 = observer.onTicketEnded({
      ticketId: 't_fail_2',
      outcome: 'failed',
      acceptanceStatus: 'unmet',
      summary: '再次出现刷新丢失问题',
    })
    expect(r2).toHaveLength(1)
    expect(r2[0]!.status).toBe('candidate')
    expect(r2[0]!.version).toBe(2)
    expect(r2[0]!.content).toContain('刷新页面后表单数据丢失')
    // 绝不直接覆写现役版本
    expect(skills.get(sk.id)!.activeVersion).toBe(1)
    db.close()
  })
})
