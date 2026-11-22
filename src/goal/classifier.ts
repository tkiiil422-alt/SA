/**
 * 目标验收失败原因智能分类器（Goal Failure Classifier）。
 *
 * 在触发模型阶梯升级（Escalation）前，先基于客观验收命令输出、缺失项与错误特征做确定性分类：
 * - `need_info`：需求歧义、缺少凭据/权限/外部账号信息 → 应提问主人，不盲目升级贵模型；
 * - `env_error`：缺依赖包、只读文件系统、端口占用、网络超时/DNS、容器环境缺失 → 应修环境或告知缺包，不换模型；
 * - `reasoning_blocked`：单元测试逻辑失败、类型/语法报错反复修不好、需求未逐条实现 → 才适合在预算内升级强推理模型破局！
 */
import type { GoalCheck } from './service.ts'

export type FailureCategory = 'need_info' | 'env_error' | 'reasoning_blocked'

export interface FailureDiagnosis {
  category: FailureCategory
  reason: string
  recommendedAction: 'ask_user' | 'fix_env' | 'escalate_model'
  repeatedError: boolean
}

const NEED_INFO_PATTERNS = [
  /缺少.*(凭据|密钥|token|密码|口令|账号|配置|权限|说明|前提)/i,
  /需要.*(确认|澄清|提供|授权|明确|指定)/i,
  /未提供.*(url|地址|账号|表结构|口径|需求)/i,
  /(401|403|unauthorized|forbidden|invalid api key|missing .*secret|access denied)/i,
]

const ENV_ERROR_PATTERNS = [
  /command not found|not recognized as an internal|No such file or directory.*bin/i,
  /ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|network is unreachable|socket hang up/i,
  /Read-only file system|Permission denied|EACCES|ENOSPC|no space left/i,
  /ModuleNotFoundError|Cannot find package|ERR_MODULE_NOT_FOUND|Failed to download|pip.*error|apt-get/i,
  /browserType\.launch|executable doesn't exist|playwright.*install/i,
]

function extractErrorSignature(check: GoalCheck): string {
  const parts: string[] = []
  for (const cmd of check.commands) {
    if (cmd.code !== 0) parts.push(`${cmd.command}:${cmd.code}:${cmd.tail.slice(-180)}`)
  }
  if (check.error) parts.push(check.error)
  if (check.verdict && !check.verdict.met) {
    parts.push(...check.verdict.missing, check.verdict.summary)
  }
  if (parts.length === 0) parts.push(check.summary)
  return parts.join('\n').trim()
}

/** 结合最近几轮验收检查结果，判断根因分类及是否陷入重复同类报错。 */
export function classifyGoalFailure(checks: readonly GoalCheck[]): FailureDiagnosis {
  const recent = checks.filter(c => !c.met).slice(-3)
  const latest = recent.at(-1)
  if (!latest) {
    return { category: 'reasoning_blocked', reason: '目标尚未达成', recommendedAction: 'escalate_model', repeatedError: false }
  }

  const text = extractErrorSignature(latest)
  const prev = recent.length >= 2 ? extractErrorSignature(recent[recent.length - 2]!) : ''
  const repeatedError = Boolean(prev && text && (
    prev.slice(0, 120) === text.slice(0, 120)
    || latest.summary === recent[recent.length - 2]!.summary
  ))

  for (const pat of NEED_INFO_PATTERNS) {
    if (pat.test(text)) {
      return {
        category: 'need_info',
        reason: `疑似缺少前置信息、凭据或业务口径确认（命中特征：${text.slice(0, 140)}）`,
        recommendedAction: 'ask_user',
        repeatedError,
      }
    }
  }

  for (const pat of ENV_ERROR_PATTERNS) {
    if (pat.test(text)) {
      return {
        category: 'env_error',
        reason: `疑似执行环境、依赖或网络异常（命中特征：${text.slice(0, 140)}）`,
        recommendedAction: 'fix_env',
        repeatedError,
      }
    }
  }

  return {
    category: 'reasoning_blocked',
    reason: repeatedError
      ? `连续出现同类验收失败（${latest.summary.slice(0, 140)}），当前模型可能陷入局部推理瓶颈`
      : `连续多轮验收未通过（${latest.summary.slice(0, 140)}），适合在预算内升级更强推理模型接管`,
    recommendedAction: 'escalate_model',
    repeatedError,
  }
}
