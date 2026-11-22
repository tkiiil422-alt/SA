/**
 * 稳定典型任务评测基准集与进化指标追踪（V2.3）。
 *
 * 复用 `src/eval/harness.ts`，聚焦个人智能助手最核心的四项持续对比指标：
 * - `firstPassAcceptanceRate`：首次验收通过率
 * - `humanInterventions`：人工介入次数
 * - `costPerPassingTaskUsd`：每个通过任务的平均美元成本
 * - `postAcceptanceReworkRate`：验收后返工率
 *
 * 首批稳定样例涵盖两大日常高频场景：
 * 1. `webpage-form-edit`：网页改动与提交刷新持久化断言；
 * 2. `weekly-sales-report`：周期性销售周报（按付款日期统计、金额严格保留两位小数）。
 */
import { randomBytes } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { BenchmarkMetrics } from '../shared/api-types.ts'
import { runEvalSuite, type EvalCase, type EvalSuiteReport } from './harness.ts'

export type { BenchmarkMetrics }

export interface BenchmarkTaskObservation {
  taskId: string
  category: 'webpage_edit' | 'weekly_report' | 'general'
  passed: boolean
  firstPassAccepted: boolean
  humanInterventions: number
  costUsd: number
  reworkedAfterAcceptance: boolean
}

export interface BenchmarkRunRecord {
  id: string
  suiteName: string
  label: string
  metrics: BenchmarkMetrics
  report: EvalSuiteReport
  createdAt: string
}

/** 根据一组任务观测记录计算四大核心业务评测指标。 */
export function computeBenchmarkMetrics(observations: readonly BenchmarkTaskObservation[]): BenchmarkMetrics {
  const totalTasks = observations.length
  const passedTasks = observations.filter(o => o.passed).length
  const firstPassCount = observations.filter(o => o.firstPassAccepted).length
  const humanInterventions = observations.reduce((s, o) => s + Math.max(0, o.humanInterventions), 0)
  const totalCostUsd = Number(observations.reduce((s, o) => s + Math.max(0, o.costUsd), 0).toFixed(6))
  const acceptedList = observations.filter(o => o.passed)
  const reworkedCount = acceptedList.filter(o => o.reworkedAfterAcceptance).length

  return {
    totalTasks,
    passedTasks,
    firstPassAcceptanceRate: totalTasks > 0 ? Number((firstPassCount / totalTasks).toFixed(4)) : 0,
    humanInterventions,
    totalCostUsd,
    costPerPassingTaskUsd: passedTasks > 0 ? Number((totalCostUsd / passedTasks).toFixed(6)) : null,
    postAcceptanceReworkRate: acceptedList.length > 0 ? Number((reworkedCount / acceptedList.length).toFixed(4)) : 0,
  }
}

/** 首批稳定典型样例集：网页改动 + 周期性销售周报。 */
export function coreBenchmarkCases(): EvalCase[] {
  return [
    {
      id: 'bench_webpage_form_edit',
      title: '网页改动：表单提交刷新持久化与浏览器自检',
      input: '修改订单表单页面，确保用户填写并提交后刷新页面数据依然存在，并通过 browser_verify 自检无控制台错误。',
      evaluate: output => {
        const lower = output.toLowerCase()
        const hasPersist = /持久化|reload|刷新.*保留|submit|form/.test(lower)
        const hasVerify = /browser_verify|断言|自检|证据|screenshot|snapshot/.test(lower)
        const noFakePass = !/跳过验证|无需测试/.test(lower)
        const pass = hasPersist && hasVerify && noFakePass
        return {
          pass,
          score: (hasPersist ? 0.45 : 0) + (hasVerify ? 0.45 : 0) + (noFakePass ? 0.1 : 0),
          reason: pass ? '覆盖表单持久化与浏览器自检证据要求' : '缺少刷新持久化验证或浏览器自检证据约束',
        }
      },
    },
    {
      id: 'bench_weekly_sales_report',
      title: '周期性销售周报：按付款日期归集且金额保留两位小数',
      input: '整理本周销售周报，按最新口径输出分渠道汇总与总额并核对数据。',
      evaluate: output => {
        const lower = output.toLowerCase()
        const hasPaidDate = /付款日期|paid_at|付款时间/.test(lower)
        const hasTwoDecimals = /两位小数|保留2位|0\.00|toFixed\(2\)|\.\d{2}/.test(lower)
        const pass = hasPaidDate && hasTwoDecimals
        return {
          pass,
          score: (hasPaidDate ? 0.5 : 0) + (hasTwoDecimals ? 0.5 : 0),
          reason: pass ? '严格遵循付款日期与两位小数口径' : '未严格遵循“按付款日期”或“保留两位小数”口径',
        }
      },
    },
  ]
}

export class BenchmarkStore {
  constructor(private readonly db: DatabaseSync) {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS eval_runs (
        id TEXT PRIMARY KEY,
        suite_name TEXT NOT NULL,
        label TEXT NOT NULL,
        metrics_json TEXT NOT NULL,
        report_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_eval_runs_suite ON eval_runs(suite_name, created_at DESC);
    `)
  }

  async runAndRecord(input: {
    suiteName: string
    label: string
    cases?: readonly EvalCase[]
    runner: (item: EvalCase) => Promise<{
      output: string
      usd?: number
      firstPass?: boolean
      humanInterventions?: number
      reworkedAfterAcceptance?: boolean
    }>
  }, now = new Date()): Promise<BenchmarkRunRecord> {
    const cases = input.cases ?? coreBenchmarkCases()
    const obs: BenchmarkTaskObservation[] = []
    const report = await runEvalSuite(input.suiteName, input.label, cases, async c => {
      const r = await input.runner(c)
      const verdict = c.evaluate(r.output)
      obs.push({
        taskId: c.id,
        category: c.id.includes('webpage') ? 'webpage_edit' : c.id.includes('sales') ? 'weekly_report' : 'general',
        passed: verdict.pass,
        firstPassAccepted: verdict.pass && (r.firstPass ?? true),
        humanInterventions: r.humanInterventions ?? 0,
        costUsd: r.usd ?? 0,
        reworkedAfterAcceptance: Boolean(r.reworkedAfterAcceptance),
      })
      return { output: r.output, ...(r.usd !== undefined ? { usd: r.usd } : {}) }
    })

    const metrics = computeBenchmarkMetrics(obs)
    const id = `eval_${randomBytes(5).toString('hex')}`
    const createdAt = now.toISOString()
    this.db.prepare(`
      INSERT INTO eval_runs (id, suite_name, label, metrics_json, report_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, input.suiteName, input.label, JSON.stringify(metrics), JSON.stringify(report), createdAt)
    return { id, suiteName: input.suiteName, label: input.label, metrics, report, createdAt }
  }

  listRuns(suiteName?: string, limit = 20): BenchmarkRunRecord[] {
    const rows = (suiteName
      ? this.db.prepare('SELECT * FROM eval_runs WHERE suite_name = ? ORDER BY created_at DESC LIMIT ?').all(suiteName, limit)
      : this.db.prepare('SELECT * FROM eval_runs ORDER BY created_at DESC LIMIT ?').all(limit)) as unknown as {
      id: string
      suite_name: string
      label: string
      metrics_json: string
      report_json: string
      created_at: string
    }[]
    return rows.map(r => ({
      id: r.id,
      suiteName: r.suite_name,
      label: r.label,
      metrics: JSON.parse(r.metrics_json) as BenchmarkMetrics,
      report: JSON.parse(r.report_json) as EvalSuiteReport,
      createdAt: r.created_at,
    }))
  }
}
