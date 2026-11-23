/**
 * 主人意图与偏好学习纯逻辑模块（0 Token 零额外调用开销）：
 * 1. 从自然语言对话中精准识别显式偏好、习惯约定与红线纠正信号（如“以后都用…/记住…/不要再…/默认采用…”）；
 * 2. 将长期记忆中的偏好、决策、避坑与高命中记录综合为简洁的「主人画像（Owner Intent Profile）」，
 *    注入总控与执行者提示词，让系统越用越懂主人意图。
 */
import type { MemoryKind, MemoryRecord } from '../shared/api-types.ts'

export interface DetectedIntentSignal {
  kind: MemoryKind
  title: string
  content: string
  tags: string[]
  pinned: boolean
  confidence: number
}

export interface OwnerProfileSummary {
  preferences: MemoryRecord[]
  decisions: MemoryRecord[]
  pitfalls: MemoryRecord[]
  recentCorrections: MemoryRecord[]
  autoLearnedCount: number
  totalActive: number
  promptBlock: string
}

const PREF_PATTERNS: { re: RegExp; kind: MemoryKind; tag: string; pinned: boolean }[] = [
  {
    re: /(?:以后|之后|往后|下次|今后|每次)(?:都|统一|默认|优先|一律|尽量|必须|记住)(?:用|使用|采用|按|以|保持|输出|走)?([^。！？\n]{4,140})/,
    kind: 'preference',
    tag: 'habit',
    pinned: true,
  },
  {
    re: /(?:请记住|记住一点|记住|记下来|牢记)[：:，,\s]*([^。！？\n]{4,140})/,
    kind: 'preference',
    tag: 'remember',
    pinned: true,
  },
  {
    re: /(?:不要再|别再|切忌|禁止|千万别|以后不要|以后别)([^。！？\n]{4,140})/,
    kind: 'pitfall',
    tag: 'redline',
    pinned: true,
  },
  {
    re: /(?:我的习惯是|我习惯|我更喜欢|我偏好|默认偏好)[：:，,\s]*([^。！？\n]{4,140})/,
    kind: 'preference',
    tag: 'style',
    pinned: true,
  },
  {
    re: /(?:按这个规范|按这个口径|统一规范|统一口径)[：:，,\s]*([^。！？\n]{4,140})/,
    kind: 'decision',
    tag: 'standard',
    pinned: false,
  },
]

const SKIP_QUESTION_RE = /[？?]$|^(?:请问|能不能|是不是|为什么|怎么|如何|查一下|看看)/

function deriveTitle(kind: MemoryKind, body: string): string {
  const cleaned = body.replace(/^[\s：:，,、-]+/, '').trim()
  const prefix = kind === 'pitfall' ? '红线约束：' : kind === 'decision' ? '统一约定：' : '主人偏好：'
  const core = cleaned.length <= 28 ? cleaned : `${cleaned.slice(0, 27)}…`
  return `${prefix}${core}`
}

/**
 * 从单条用户消息中检测显式偏好/红线/规范信号。
 * 保守过滤问句、命令和过短片段，防止误写入噪音记忆。
 */
export function detectIntentSignals(userText: string): DetectedIntentSignal[] {
  const trimmed = userText.trim()
  if (trimmed.length < 6 || trimmed.length > 2000 || trimmed.startsWith('/')) return []
  // 去掉前端附加的「[需求上下文约束]」块，只分析用户真实意图
  const cleaned = trimmed.replace(/^\[需求上下文约束\][\s\S]*?\n\n/, '').trim()
  if (!cleaned) return []

  const sentences = cleaned
    .split(/[\n。！？；;]+/)
    .map(s => s.trim())
    .filter(s => s.length >= 6 && !SKIP_QUESTION_RE.test(s))

  const seen = new Set<string>()
  const signals: DetectedIntentSignal[] = []

  for (const sentence of sentences) {
    for (const rule of PREF_PATTERNS) {
      const m = rule.re.exec(sentence)
      if (!m) continue
      const body = sentence.slice(0, 260).trim()
      const key = `${rule.kind}:${body.toLowerCase()}`
      if (seen.has(key)) continue
      seen.add(key)
      signals.push({
        kind: rule.kind,
        title: deriveTitle(rule.kind, m[1] || body),
        content: body,
        tags: ['auto_intent', rule.tag],
        pinned: rule.pinned,
        confidence: rule.kind === 'pitfall' ? 0.94 : 0.9,
      })
      if (signals.length >= 3) return signals
      break
    }
  }
  return signals
}

/**
 * 从活跃记忆中提炼「主人意图画像与偏好档案」，用于总控提示词注入和前端可视化展示。
 */
export function buildOwnerIntentProfile(memories: readonly MemoryRecord[]): OwnerProfileSummary {
  const active = memories.filter(m => !m.supersededBy)
  const sortPriority = (a: MemoryRecord, b: MemoryRecord): number =>
    Number(b.pinned) - Number(a.pinned)
    || Number(Boolean(b.supersedesId)) - Number(Boolean(a.supersedesId))
    || b.confidence - a.confidence
    || b.useCount - a.useCount
    || b.updatedAt.localeCompare(a.updatedAt)

  const preferences = active
    .filter(m => m.scope === 'user' && m.kind === 'preference')
    .sort(sortPriority)
    .slice(0, 8)
  const decisions = active
    .filter(m => m.kind === 'decision')
    .sort(sortPriority)
    .slice(0, 6)
  const pitfalls = active
    .filter(m => m.kind === 'pitfall')
    .sort(sortPriority)
    .slice(0, 6)
  const recentCorrections = active
    .filter(m => Boolean(m.supersedesId) || m.source === 'user_correction' || m.source === 'auto_intent')
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, 6)
  const autoLearnedCount = active.filter(m => m.source === 'auto_intent' || m.source === 'auto_retro' || m.source === 'user_correction').length

  const lines: string[] = []
  if (preferences.length > 0 || pitfalls.length > 0 || decisions.length > 0) {
    lines.push('## 主人意图画像与偏好档案（持续学习）')
    if (preferences.length > 0) {
      lines.push('### 核心习惯与偏好（默认遵守，无需反复询问）')
      for (const m of preferences.slice(0, 5)) {
        lines.push(`- ${m.pinned ? '[置顶]' : ''} ${m.title}：${m.content.replace(/\s+/g, ' ').slice(0, 140)}`)
      }
    }
    if (pitfalls.length > 0) {
      lines.push('### 红线约束与避坑经验（严格避免重犯）')
      for (const m of pitfalls.slice(0, 4)) {
        lines.push(`- ${m.title}：${m.content.replace(/\s+/g, ' ').slice(0, 140)}`)
      }
    }
    if (decisions.length > 0) {
      lines.push('### 已敲定的长期决策与口径')
      for (const m of decisions.slice(0, 4)) {
        lines.push(`- ${m.title}：${m.content.replace(/\s+/g, ' ').slice(0, 140)}`)
      }
    }
  }

  return {
    preferences,
    decisions,
    pitfalls,
    recentCorrections,
    autoLearnedCount,
    totalActive: active.length,
    promptBlock: lines.join('\n'),
  }
}
