/**
 * 轻量级离线回放与评测框架基座（Eval Harness）。
 *
 * 用于量化评估不同模型配置、Director Prompt、记忆召回或工具策略在基准用例集上的：
 * - 通过率（passRate）
 * - 平均耗时（avgMs）
 * - 累计美元成本（totalUsd）
 * 并输出可直接落盘或汇报的 Markdown 对比报告。
 */

export interface EvalCase {
  id: string
  title: string
  input: string
  /** 断言函数：返回 `{ pass, score?, reason? }`。 */
  evaluate: (output: string) => { pass: boolean; score?: number; reason?: string }
}

export interface EvalRunOutput {
  output: string
  usd?: number
  tokens?: number
}

export interface EvalCaseResult {
  id: string
  title: string
  pass: boolean
  score: number
  durationMs: number
  usd: number
  reason?: string
}

export interface EvalSuiteReport {
  suiteName: string
  label: string
  ranAt: string
  total: number
  passed: number
  passRate: number
  avgScore: number
  avgMs: number
  totalUsd: number
  cases: EvalCaseResult[]
}

/** 对一组基准用例执行评测，收集成功率、耗时与花费指标。 */
export async function runEvalSuite(
  suiteName: string,
  label: string,
  cases: readonly EvalCase[],
  runner: (item: EvalCase) => Promise<EvalRunOutput>,
): Promise<EvalSuiteReport> {
  const results: EvalCaseResult[] = []
  for (const item of cases) {
    const t0 = Date.now()
    try {
      const ran = await runner(item)
      const verdict = item.evaluate(ran.output)
      results.push({
        id: item.id,
        title: item.title,
        pass: verdict.pass,
        score: verdict.score ?? (verdict.pass ? 1 : 0),
        durationMs: Date.now() - t0,
        usd: Number(ran.usd ?? 0),
        ...(verdict.reason ? { reason: verdict.reason } : {}),
      })
    } catch (error) {
      results.push({
        id: item.id,
        title: item.title,
        pass: false,
        score: 0,
        durationMs: Date.now() - t0,
        usd: 0,
        reason: error instanceof Error ? error.message : String(error),
      })
    }
  }

  const total = results.length
  const passed = results.filter(r => r.pass).length
  const totalMs = results.reduce((s, r) => s + r.durationMs, 0)
  const totalUsd = results.reduce((s, r) => s + r.usd, 0)
  const totalScore = results.reduce((s, r) => s + r.score, 0)

  return {
    suiteName,
    label,
    ranAt: new Date().toISOString(),
    total,
    passed,
    passRate: total > 0 ? passed / total : 0,
    avgScore: total > 0 ? totalScore / total : 0,
    avgMs: total > 0 ? Math.round(totalMs / total) : 0,
    totalUsd: Number(totalUsd.toFixed(6)),
    cases: results,
  }
}

/** 将多份评测报告渲染为简洁的 Markdown 对比表。 */
export function formatEvalComparison(reports: readonly EvalSuiteReport[]): string {
  const lines = [
    '| 方案 / 模型 | 通过率 | 平均分 | 平均耗时 | 总花费 |',
    '| --- | --- | --- | --- | --- |',
  ]
  for (const r of reports) {
    lines.push(
      `| ${r.label} | ${r.passed}/${r.total} (${Math.round(r.passRate * 100)}%) | ${(r.avgScore * 100).toFixed(1)} | ${r.avgMs} ms | $${r.totalUsd.toFixed(4)} |`,
    )
  }
  return lines.join('\n')
}
