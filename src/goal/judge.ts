/** The goal judge's prompt and the parsing of its answer; the model call itself is the runtime's (`judgeGoal`). */
import type { GoalFile, JudgeInput, Verdict } from './service.ts'

export const JUDGE_SYSTEM = [
  '你是任务验收的裁判。根据目标、执行者的交付说明、宿主实际跑出的验收命令结果、工作区概况和宿主读出的文件内容，判断目标是否已经达成。',
  '宿主读出的文件内容是真实的，以它为准；执行者的说明和它不一致时，信文件。目标点名的文件没出现在材料里，说明工作区里没有这个文件。',
  '规则：只依据给出的材料，不猜测；执行者自己说“做完了”不算证据；验收命令有任何一条失败就判未达成；材料不足以证明某一条要求时，判未达成，并在 missing 里写清要补什么。',
  '只输出一个 JSON 对象，不要别的文字：{"met": true 或 false, "evidence": ["逐条对照目标的证据"], "missing": ["还差什么，写成执行者能直接照做的话；met 为 false 时必填"], "summary": "一句话结论"}',
].join('\n')

const clip = (text: string, limit: number): string => text.length <= limit ? text : `${text.slice(0, limit)}…`

export function judgeUser(input: JudgeInput): string {
  const commands = input.commands.length > 0
    ? input.commands.map(item => `$ ${item.command}\n退出码 ${item.code}，${(item.ms / 1000).toFixed(1)} 秒\n${item.tail || '（没有输出）'}`).join('\n\n')
    : '（这个目标没有验收命令）'
  return [
    `## 目标\n${input.goal.text}`,
    `## 执行者的交付说明\n${input.summary.trim() || '（没写）'}`,
    `## 验收命令（宿主实际运行的结果）\n${commands}`,
    ...(input.context.trim() ? [`## 工作区概况\n${clip(input.context.trim(), 6000)}`] : []),
    ...(input.files && input.files.length > 0 ? [`## 目标里点名的文件（宿主直接从工作区读出的内容）\n${input.files.map(fileBlock).join('\n\n')}`] : []),
  ].join('\n\n')
}

function fileBlock(file: GoalFile): string {
  if (file.binary) return `### ${file.path}\n（二进制文件，${file.size} 字节，没有展示内容）`
  const note = file.truncated ? `（共 ${file.size} 字节，只给出开头部分）` : `（${file.size} 字节）`
  const fence = file.text.includes('```') ? '~~~~' : '```'
  return `### ${file.path} ${note}\n${fence}\n${file.text}\n${fence}`
}

/** The judge's JSON, tolerating a code fence or words around it; undefined when there is no usable verdict. */
export function parseVerdict(text: string): Verdict | undefined {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return undefined
  let value: unknown
  try {
    value = JSON.parse(text.slice(start, end + 1))
  } catch {
    return undefined
  }
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Record<string, unknown>
  if (typeof record.met !== 'boolean') return undefined
  const list = (items: unknown): string[] => Array.isArray(items)
    ? items.filter((item): item is string => typeof item === 'string' && item.trim() !== '').map(item => clip(item.trim(), 400)).slice(0, 12)
    : []
  const missing = list(record.missing)
  return {
    met: record.met,
    evidence: list(record.evidence),
    missing: record.met || missing.length > 0 ? missing : ['判定模型认为还没达成，但没说差什么'],
    summary: typeof record.summary === 'string' ? clip(record.summary.trim(), 300) : '',
  }
}
