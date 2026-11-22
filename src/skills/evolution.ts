/**
 * 技能自动进化与版本门禁引擎（SkillEvolutionService）。
 *
 * 工作流：
 * 1. 从用户纠正、反复返工或重复成功中生成候选修订版（`proposeCandidate`），绝不直接覆写线上版；
 * 2. 在同一批历史典型任务样例（`EvalCase[]`）上对比【候选新版】与【当前生效版】（`evaluateCandidate`）；
 * 3. 只有新版在通过率与平均分上均不低于旧版（且无任何原本通过的用例退化为失败）时才切换生效，
 *    旧版自动保留为 `previousVersion`；若发生退化则自动拒绝并保留旧版；
 * 4. 线上若后续观测到退化，随时可一键 `rollback()` 恢复上一版。
 */
import type { SkillRecord, SkillStore, SkillVersionRecord } from './store.ts'
import { runEvalSuite, type EvalCase, type EvalRunOutput, type EvalSuiteReport } from '../eval/harness.ts'

export interface CandidateEvaluationOutcome {
  skillId: string
  candidateVersion: number
  baselineVersion: number
  promoted: boolean
  reason: string
  regressedCases: string[]
  baselineReport: EvalSuiteReport
  candidateReport: EvalSuiteReport
  skill: SkillRecord
}

export class SkillEvolutionService {
  constructor(private readonly skills: SkillStore) {}

  /** 基于用户纠正、反复返工或重复成功，为现有技能创建候选修订版。 */
  proposeCandidate(
    skillIdOrSlug: string,
    input: {
      content: string
      triggers?: string[]
      source: 'user_correction' | 'repeated_rework' | 'repeated_success' | 'manual'
      reason: string
    },
    now = new Date(),
  ): SkillVersionRecord {
    const skill = this.skills.get(skillIdOrSlug) ?? this.skills.getBySlug(skillIdOrSlug)
    if (!skill) throw new Error(`找不到技能 ${skillIdOrSlug}`)
    return this.skills.createCandidateVersion(skill.id, input, now)
  }

  /**
   * 在同一批历史样例上对比当前生效版（baseline）与候选新版（candidate）：
   * - `executeWithSkill(skillContent, evalCase)` 由调用方/测试注入执行逻辑；
   * - 若候选版在任意原本通过的历史样例上退化，或总通过率/平均分下降，拒绝切换并保留现役旧版；
   * - 通过对比且开启 `autoPromote !== false` 时自动切换为现役版，旧版保留为 `previousVersion`。
   */
  async evaluateCandidate(
    skillIdOrSlug: string,
    candidateVersion: number,
    cases: readonly EvalCase[],
    executeWithSkill: (skillContent: string, item: EvalCase) => Promise<EvalRunOutput> | EvalRunOutput,
    opts: { autoPromote?: boolean; now?: Date } = {},
  ): Promise<CandidateEvaluationOutcome> {
    const skill = this.skills.get(skillIdOrSlug) ?? this.skills.getBySlug(skillIdOrSlug)
    if (!skill) throw new Error(`找不到技能 ${skillIdOrSlug}`)
    const candidate = this.skills.getVersion(skill.id, candidateVersion)
    if (!candidate) throw new Error(`找不到技能 ${skill.slug} 的候选版本 v${candidateVersion}`)
    if (cases.length === 0) throw new Error('至少需要 1 个历史评测样例才能评估候选技能')

    const baselineVersion = skill.activeVersion
    const baselineReport = await runEvalSuite(
      `skill:${skill.slug}`,
      `active-v${baselineVersion}`,
      cases,
      async item => Promise.resolve(executeWithSkill(skill.content, item)),
    )
    const candidateReport = await runEvalSuite(
      `skill:${skill.slug}`,
      `candidate-v${candidateVersion}`,
      cases,
      async item => Promise.resolve(executeWithSkill(candidate.content, item)),
    )

    // 逐例检测退化：只要原本通过的样例在新版变为失败，直接判退化
    const baseById = new Map(baselineReport.cases.map(c => [c.id, c]))
    const regressedCases = candidateReport.cases
      .filter(c => baseById.get(c.id)?.pass === true && !c.pass)
      .map(c => c.id)

    const noRegression = regressedCases.length === 0
      && candidateReport.passRate >= baselineReport.passRate
      && candidateReport.avgScore + 1e-6 >= baselineReport.avgScore

    const comparison = {
      baselineVersion,
      candidateVersion,
      baselinePassRate: baselineReport.passRate,
      candidatePassRate: candidateReport.passRate,
      baselineAvgScore: baselineReport.avgScore,
      candidateAvgScore: candidateReport.avgScore,
      regressedCases,
    }

    if (!noRegression) {
      this.skills.rejectVersion(skill.id, candidateVersion, comparison)
      const reason = regressedCases.length > 0
        ? `候选版 v${candidateVersion} 在历史样例 [${regressedCases.join(', ')}] 上发生退化，已保留当前版本 v${baselineVersion}`
        : `候选版 v${candidateVersion} 评测未优于当前版（通过率 ${Math.round(candidateReport.passRate * 100)}% vs ${Math.round(baselineReport.passRate * 100)}%），已保留 v${baselineVersion}`
      return {
        skillId: skill.id,
        candidateVersion,
        baselineVersion,
        promoted: false,
        reason,
        regressedCases,
        baselineReport,
        candidateReport,
        skill: this.skills.get(skill.id)!,
      }
    }

    if (opts.autoPromote === false) {
      return {
        skillId: skill.id,
        candidateVersion,
        baselineVersion,
        promoted: false,
        reason: `候选版 v${candidateVersion} 已通过历史样例对比，等待手动启用`,
        regressedCases: [],
        baselineReport,
        candidateReport,
        skill: this.skills.get(skill.id)!,
      }
    }

    const updated = this.skills.promoteVersion(skill.id, candidateVersion, comparison, opts.now ?? new Date())
    return {
      skillId: skill.id,
      candidateVersion,
      baselineVersion,
      promoted: true,
      reason: `候选版 v${candidateVersion} 通过全部历史样例对比（通过率 ${Math.round(baselineReport.passRate * 100)}% → ${Math.round(candidateReport.passRate * 100)}%），已切换生效并保留 v${baselineVersion} 供回退`,
      regressedCases: [],
      baselineReport,
      candidateReport,
      skill: updated,
    }
  }

  /** 发现线上退化时一键恢复上一版生效技能。 */
  rollback(skillIdOrSlug: string, reason?: string, now = new Date()): SkillRecord {
    const skill = this.skills.get(skillIdOrSlug) ?? this.skills.getBySlug(skillIdOrSlug)
    if (!skill) throw new Error(`找不到技能 ${skillIdOrSlug}`)
    return this.skills.rollbackVersion(skill.id, reason, now)
  }
}
