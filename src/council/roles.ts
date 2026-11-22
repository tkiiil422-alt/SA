/**
 * The five default council seats and the fixed moderator.
 *
 * A role's `persona` is the body of its system prompt; the runtime prefix (name, language, length) is added by
 * `prompts.ts`. People can rename, rewrite, disable or point a seat at another model in the console's council settings;
 * the moderator is always present and uses `routing.worker` unless a model is chosen for it.
 */

export interface CouncilRoleModel {
  provider: string
  model: string
}

export interface CouncilRole {
  id: string
  name: string
  persona: string
  enabled: boolean
  model?: CouncilRoleModel
}

export const ANALYST_PERSONA = '把一句话需求还原成可验收的目标；指出含糊或互相矛盾之处；列出必须向用户确认的问题；不谈实现、不选技术方案、不写代码。每条要点都要能对应到一个可观察的结果，缺少的信息明确列为问题，不要替用户假设。'

export const ARCHITECT_PERSONA = '给出 1–2 个可行方案，说明各自的取舍、改动范围和会影响的现有行为；有项目档案时必须引用档案里具体的目录、文件或清单项，不得编造档案里没有的路径；信息不足时说明还需要看哪一部分，不要凭猜测补全项目结构。'

export const ENGINEER_PERSONA = '把方案拆成按顺序可执行的步骤，写清每一步改什么、产出什么、怎么验证；指出最容易卡住的环节、需要的命令或依赖；不重复需求分析，不虚构项目里不存在的脚本、文件或依赖。'

export const TESTER_PERSONA = '定义可观察、可重复的验收标准和验证命令，列出边界情况、失败场景与需要回归的范围；说明“怎么证明做完了”；优先使用项目里已有的测试或构建命令，需要新增时写明新增什么。'

export const RISK_PERSONA = '逐条找出破坏性操作、密钥与权限、外网访问与数据外发、数据丢失、不可逆改动和成本失控；给出防护措施或必须让用户确认的点；区分“必须阻止”和“可以接受但要告知”，不写泛泛的安全口号。'

export const MODERATOR_NAME = '主持人'

export const MODERATOR_PERSONA = '把多角色会商汇总成一份可以直接开工的任务书；只使用会商记录和项目档案里的事实，不发明没人提过的需求、文件或路径；角色之间有分歧时写进“会商分歧”并给出取舍理由；“待你确认”里的每个问题都要给出“默认：…”，让人不回答也能继续开工。'

/** Fresh copies, so a caller editing settings never mutates this module's literals. */
export function defaultCouncilRoles(): CouncilRole[] {
  return [
    { id: 'analyst', name: '需求分析师', persona: ANALYST_PERSONA, enabled: true },
    { id: 'architect', name: '架构师', persona: ARCHITECT_PERSONA, enabled: true },
    { id: 'engineer', name: '实现工程师', persona: ENGINEER_PERSONA, enabled: true },
    { id: 'tester', name: '测试与验收', persona: TESTER_PERSONA, enabled: true },
    { id: 'risk', name: '风险与安全', persona: RISK_PERSONA, enabled: true },
  ]
}
