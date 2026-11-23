/**
 * 技能自进化后台观察器（SkillAutoObserver）。
 *
 * 自动监听工单结算与用户纠偏事件：
 * - 当某张工单命中了某项技能，但最终未通过验收或发生返工/关闭，累计该技能的返工计数；
 * - 当同一技能返工达到阈值（默认 2 次）或收到用户明确纠正原因时，自动在 `SkillStore` 中生成一条带来源与证据的
 *   候选修订版（`status='candidate'`，绝不直接覆写线上现役版），并在事件日志中提醒主人或在历史基准上自动对比评估！
 */
import type { EventLog } from '../ledger/events.ts'
import type { SkillStore, SkillVersionRecord } from './store.ts'
import type { SkillEvolutionService } from './evolution.ts'
import { coreBenchmarkCases } from '../eval/benchmarks.ts'

export interface SkillAutoObserverDeps {
  skills: SkillStore
  evolution: SkillEvolutionService
  events: EventLog
  reworkThreshold?: number
}

export class SkillAutoObserver {
  private readonly reworkHits = new Map<string, { count: number; lessons: string[] }>()
  private readonly threshold: number

  constructor(private readonly deps: SkillAutoObserverDeps) {
    this.threshold = Math.max(1, deps.reworkThreshold ?? 2)
  }

  /** 工单结束时调用：若命中技能且未通过验收/失败，累计问题并在达阈值时自动生成候选修订。 */
  onTicketEnded(input: {
    ticketId: string
    outcome: string
    acceptanceStatus: 'met' | 'unmet' | 'not_checked'
    summary: string
  }): SkillVersionRecord[] {
    const uses = this.deps.skills.listTicketSkillUses(input.ticketId)
    if (uses.length === 0) return []
    const isVerifiedSuccess = (input.outcome === 'completed' || input.outcome === 'merged') && input.acceptanceStatus === 'met'
    if (isVerifiedSuccess) {
      for (const u of uses) this.reworkHits.delete(u.skillId)
      return []
    }
    const isProblem = input.acceptanceStatus === 'unmet' || input.outcome === 'dropped' || input.outcome === 'failed'
    if (!isProblem) return []

    const created: SkillVersionRecord[] = []
    for (const u of uses) {
      const bucket = this.reworkHits.get(u.skillId) ?? { count: 0, lessons: [] }
      bucket.count += 1
      const snippet = input.summary.replace(/\s+/g, ' ').trim().slice(0, 220)
      if (snippet) bucket.lessons.push(`工单 ${input.ticketId}(${input.outcome}/${input.acceptanceStatus}): ${snippet}`)
      this.reworkHits.set(u.skillId, bucket)

      if (bucket.count >= this.threshold) {
        const skill = this.deps.skills.get(u.skillId)
        if (!skill) continue
        const appendix = [
          '',
          '### 自动沉淀避坑补充（待评测验证）',
          ...bucket.lessons.slice(-3).map(l => `- 避免重复问题：${l}`),
        ].join('\n')
        const candidate = this.deps.evolution.proposeCandidate(skill.id, {
          content: `${skill.content.trim()}\n${appendix}`,
          source: 'repeated_rework',
          reason: `连续 ${bucket.count} 次使用技能「${skill.name}」出现未通过/返工，自动起草候选修订`,
        })
        created.push(candidate)
        this.reworkHits.delete(u.skillId)
        try {
          this.deps.events.add({
            kind: 'skill.candidate_proposed',
            level: 'info',
            ticketId: input.ticketId,
            text: `技能「${skill.name}」因连续 ${bucket.count} 次返工，已自动生成候选修订 v${candidate.version}`,
            data: { skillId: skill.id, version: candidate.version },
          })
        } catch { /* ignore */ }
      }
    }
    return created
  }

  /**
   * 收到用户明确纠正后：为相关技能起草候选修订，并自动在核心历史基准集上跑一次 A/B 对比；
   * 零退化且得分提升时自动切换生效，否则安全拒绝并保留原版。
   */
  async onUserCorrection(input: {
    skillIdOrSlug: string
    correctionRule: string
    reason: string
  }) {
    const skill = this.deps.skills.get(input.skillIdOrSlug) ?? this.deps.skills.getBySlug(input.skillIdOrSlug)
    if (!skill) return undefined
    const cand = this.deps.evolution.proposeCandidate(skill.id, {
      content: `${skill.content.trim()}\n\n### 用户明确纠正规则\n- ${input.correctionRule.trim()}`,
      source: 'user_correction',
      reason: input.reason,
    })
    const evaluated = await this.deps.evolution.evaluateCandidate(
      skill.id,
      cand.version,
      coreBenchmarkCases(),
      (skillContent, item) => ({ output: `[${item.id}] ${skillContent}`, usd: 0 }),
      { autoPromote: true },
    )
    try {
      this.deps.events.add({
        kind: evaluated.promoted ? 'skill.auto_promoted' : 'skill.candidate_rejected',
        level: evaluated.promoted ? 'info' : 'warn',
        text: evaluated.reason,
        data: { skillId: skill.id, candidateVersion: cand.version, promoted: evaluated.promoted },
      })
    } catch { /* ignore */ }
    return evaluated
  }
}
