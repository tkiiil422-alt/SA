/**
 * 总控的「任务路由预分析」：主人说了一句新要求，到底该
 *   - 在某张旧工单上原地续做（`ticket_reply`，已结束的也会重新打开，Pi 续接原会话与工作区），
 *   - 分叉出新工单继承旧会话（`dispatch_ticket(fromTicketId)`，旧工作区已清理时用），
 *   - 还是直接新建工单，
 *   - 或者拿不准、需要先问主人？
 *
 * 这里的判断全部是代码级的、零 Token 的：用文本相似度、「刚才那个」之类的指代词、当前聚焦工单、本会话最近
 * 关联的工单、工单状态（运行中/已结束/工作区是否还在/Pi 会话是否还在）打分，给出结构化建议。结果以只读
 * 提示的形式注入总控的系统提示词，也可以用 `platform_query(task_route)` 显式查询；最终执行仍由模型结合事实决定。
 *
 * 执行原则：低风险且有把握 → 直接执行并事后一句话汇报；拿不准、涉及高风险动作、或要重开被主人手动停止
 * 的工单 → 先问主人（回复里带「续做 xxx」「新建任务」这样的引号选项，QQ/飞书会自动变成可点击按钮）。
 */
import type { AdminHost, TicketDetailView, TicketSummaryView } from '../admin/host.ts'
import { listPiSessionFiles } from '../executor/pi-sessions.ts'

export type RoutingTicketState = 'running' | 'waiting_person' | 'ended' | 'stopped'

export interface RoutingTicket {
  id: string
  title: string
  status: 'open' | 'ended'
  /** 工单当前的执行状态（用于展示与决策）。 */
  state: RoutingTicketState
  updatedAt: string
  /** 创建这张工单时主人的原始需求（截断）。 */
  requestText: string
  workspaceExists: boolean
  hasSession: boolean
}

export type RoutingAction = 'continue' | 'fork' | 'new' | 'ask'

export interface RoutingCandidate {
  ticketId: string
  title: string
  state: RoutingTicketState
  /** 0~1，综合相关度。 */
  score: number
  reasons: string[]
  /** 如果选中它，该怎么做。 */
  action: 'continue' | 'fork' | 'new'
  workspaceExists: boolean
  hasSession: boolean
}

export interface RoutingAdvice {
  action: RoutingAction
  /** 建议续做/分叉的工单；`new`/`ask` 时可能没有。 */
  ticketId?: string
  /** 0~1，对 `action` 的把握程度。 */
  confidence: number
  /** 消息里是否出现「刚才那个/继续/再加」之类的承接指代。 */
  followUpCue: boolean
  /** 消息里是否出现「新建/另外/全新」之类的明确新开意图。 */
  newCue: boolean
  /** 消息里是否带有删除、部署、重启等高风险动作词。 */
  risk: boolean
  /** 低风险且有把握，可直接执行并事后汇报；否则先问主人。 */
  autoExecute: boolean
  candidates: RoutingCandidate[]
  reason: string
  /** `ask` 时给主人的可点击选项（引号包裹，QQ/飞书自动变按钮）。 */
  askLine?: string
}

const FOLLOW_UP_CUE = /(刚才|刚刚|上一个|上个|之前(的|那|做的|说的)|那个(任务|工单|需求|功能|项目|页面|脚本|报告)?|这个(任务|工单)|继续|接着|在.{0,12}基础上|基础上|再(加|做|改|补|优化|调整|来)|追加|补充(一下|个|点)?|顺便|还有一点|返工|重做|重新做|改一下|修改一下|还是那个|同一个|上次|续做|沿用)/
const NEW_CUE = /(新建|另外(一个|的)?|重新开(一个|个)|全新|新的任务|换一个|另起|单独(开|做|建|来)|不相关|无关)/
const RISK_CUE = /(删除|清空|清理|格式化|drop\s+table|rm\s+-rf|生产环境|线上|部署|发布|重启|覆盖|回滚|force|强制|转账|付款|密钥|密码|卸载)/i
const STOP_BIGRAMS = new Set([
  '一个', '这个', '那个', '可以', '需要', '帮我', '我要', '请你', '一下', '怎么', '什么', '现在', '然后', '但是', '如果',
  '因为', '所以', '已经', '还是', '继续', '之前', '刚才', '刚刚', '基础', '上面', '我们', '你们', '他们', '的话', '是不', '不是',
  '有没', '没有', '能不', '不能', '可不', '为什', '什么', '那些', '这些', '一些', '一点', '再加', '加个', '再做', '再改', '做个',
  '改一', '一改', '下吧', '一下', '麻烦', '谢谢', '好的', '就是', '这样', '那样', '任务', '工单',
])

/** 把文本切成「中文双字词 + 英文单词」集合，用来粗略度量两段话是不是在说同一件事。 */
export function tokenize(text: string): Set<string> {
  const tokens = new Set<string>()
  const lower = text.toLowerCase()
  for (const run of lower.match(/[\u4e00-\u9fff]+/g) ?? []) {
    for (let i = 0; i < run.length - 1; i++) {
      const bigram = run.slice(i, i + 2)
      if (!STOP_BIGRAMS.has(bigram)) tokens.add(bigram)
    }
  }
  for (const word of lower.match(/[a-z0-9][a-z0-9_.-]{2,}/g) ?? []) tokens.add(word)
  return tokens
}

/** 请求里的词有多大比例出现在文档里（0~1）。 */
function coverage(request: Set<string>, doc: Set<string>): number {
  if (request.size === 0 || doc.size === 0) return 0
  let hit = 0
  for (const token of request) if (doc.has(token)) hit += 1
  return hit / request.size
}

const shortId = (id: string): string => (id.length > 12 ? id.slice(0, 8) : id)

/** 消息里是否明确点名了某张工单（完整编号，或至少 6 位的十六进制前缀）。 */
function mentionsTicket(text: string, id: string): boolean {
  if (id.length >= 4 && text.includes(id)) return true
  const lower = text.toLowerCase()
  for (const token of lower.match(/[0-9a-f]{6,32}/g) ?? []) {
    if (id.toLowerCase().startsWith(token)) return true
  }
  return false
}

function describeState(ticket: RoutingTicket): string {
  switch (ticket.state) {
    case 'running': return '运行中'
    case 'waiting_person': return '等主人回复'
    case 'stopped': return '已被手动停止'
    case 'ended': return ticket.workspaceExists ? '已结束（工作区还在）' : '已结束（工作区已清理）'
  }
}

/** 选中某张工单后该怎么做，由它的状态决定。 */
function actionFor(ticket: RoutingTicket): RoutingCandidate['action'] {
  if (ticket.status === 'open') return 'continue'
  if (ticket.workspaceExists) return 'continue'
  return ticket.hasSession ? 'fork' : 'new'
}

export interface RoutingInput {
  text: string
  tickets: readonly RoutingTicket[]
  focusTicketId?: string
  /** 本会话最近关联的工单，最新的在前。 */
  linkedTicketIds?: readonly string[]
  now: Date
}

export function adviseTaskRouting(input: RoutingInput): RoutingAdvice {
  const text = input.text.trim()
  const followUpCue = FOLLOW_UP_CUE.test(text)
  const newCue = NEW_CUE.test(text)
  const risk = RISK_CUE.test(text)
  const request = tokenize(text)
  const linked = [...(input.linkedTicketIds ?? [])]

  const scored: RoutingCandidate[] = input.tickets.map(ticket => {
    const reasons: string[] = []
    let score = 0
    if (mentionsTicket(text, ticket.id)) {
      reasons.push('你明确提到了这张工单的编号')
      score = 1
    } else {
      const sim = coverage(request, tokenize(`${ticket.title}\n${ticket.requestText}`))
      score += 0.6 * Math.min(1, sim * 2.5)
      if (sim >= 0.2) reasons.push(`内容相关度 ${Math.round(Math.min(1, sim * 2.5) * 100)}%`)
      const linkedRank = linked.indexOf(ticket.id)
      if (input.focusTicketId === ticket.id) {
        score += followUpCue ? 0.5 : 0.15
        reasons.push(followUpCue ? '是你刚才在聊的聚焦工单，且这句话带承接语气' : '是当前聚焦工单')
      } else if (linkedRank === 0) {
        score += followUpCue ? 0.25 : 0.1
        reasons.push('是本会话最近关联的工单')
      } else if (linkedRank > 0 && linkedRank < 3) {
        score += followUpCue ? 0.12 : 0.05
        reasons.push('本会话里提过这张工单')
      }
      const ageMs = input.now.getTime() - Date.parse(ticket.updatedAt)
      if (Number.isFinite(ageMs)) {
        if (ageMs < 2 * 3600_000) { score += 0.1; reasons.push('2 小时内有动静') }
        else if (ageMs < 24 * 3600_000) { score += 0.05; reasons.push('24 小时内有动静') }
      }
      if (followUpCue && sim > 0) score += 0.05
      if (newCue) score *= 0.5
    }
    return {
      ticketId: ticket.id,
      title: ticket.title,
      state: ticket.state,
      score: Math.min(1, Math.round(score * 100) / 100),
      reasons,
      action: actionFor(ticket),
      workspaceExists: ticket.workspaceExists,
      hasSession: ticket.hasSession,
    }
  }).sort((a, b) => b.score - a.score)

  const byId = new Map(input.tickets.map(t => [t.id, t]))
  const top = scored[0]
  const second = scored[1]
  const shown = scored.filter(c => c.score >= 0.2).slice(0, 3)
  const base = { followUpCue, newCue, risk, candidates: shown }

  const askBetween = (cands: RoutingCandidate[], why: string): RoutingAdvice => {
    const options: string[] = []
    for (const c of cands.slice(0, 2)) options.push(`${c.action === 'fork' ? '分叉' : '续做'} ${shortId(c.ticketId)}`)
    options.push('新建任务')
    return {
      ...base,
      action: 'ask',
      confidence: top ? top.score : 0,
      autoExecute: false,
      reason: why,
      askLine: `请回复${options.map(o => `「${o}」`).join('或')}`,
      ...(top ? { ticketId: top.ticketId } : {}),
    }
  }

  // 没有任何像样的候选：带承接语气但找不到对象 → 问；否则当作全新任务。
  if (!top || top.score < 0.35) {
    if (followUpCue && !newCue && scored.length > 0) {
      const recent = [...scored].sort((a, b) => (byId.get(b.ticketId)?.updatedAt ?? '').localeCompare(byId.get(a.ticketId)?.updatedAt ?? ''))
      return askBetween(recent.slice(0, 2), '消息带有「接着/之前那个」的承接语气，但没有哪张旧工单足够匹配，不确定指的是哪一张')
    }
    return {
      ...base,
      candidates: [],
      action: 'new',
      confidence: top ? Math.min(0.9, 1 - top.score) : 0.9,
      autoExecute: !risk,
      reason: risk ? '没有相关旧工单，按新任务处理；但内容涉及高风险动作，先向主人确认方案' : '没有明显相关的旧工单，按全新任务处理',
    }
  }

  const margin = top.score - (second?.score ?? 0)
  const confident = top.score >= 0.6 && margin >= 0.15
  if (!confident) {
    const near = scored.filter(c => top.score - c.score <= 0.15 && c.score >= 0.35)
    return askBetween(near.length > 0 ? near : [top], near.length > 1
      ? '有多张旧工单都可能是主人指的，不好擅自选择'
      : '找到了可能相关的旧工单，但把握不够，需要主人确认是续做还是新建')
  }

  const ticket = byId.get(top.ticketId)!
  // 主人手动停掉的工单：重开它违背当时的意图，必须先问。
  if (ticket.state === 'stopped') {
    return {
      ...askBetween([top], `最相关的工单 ${shortId(top.ticketId)} 曾被主人手动停止，重新打开前需要确认`),
      confidence: top.score,
    }
  }
  const action = top.action
  const why = action === 'continue'
    ? (ticket.status === 'open' ? '最相关的工单还在进行中，新要求直接交给它' : '最相关的工单已结束但工作区还在，原地重新打开续做（Pi 续接原会话与工作区）')
    : action === 'fork'
      ? '最相关的工单工作区已清理，但 Pi 会话还在：分叉出新工单继承它的会话历史'
      : '最相关的工单工作区和会话都已清理，无法续接，按新任务处理并在需求里引用它的结论'
  return {
    ...base,
    action,
    ticketId: top.ticketId,
    confidence: top.score,
    autoExecute: !risk,
    reason: risk ? `${why}；但内容涉及高风险动作，先向主人确认方案再执行` : why,
  }
}

/** 渲染成注入系统提示词的中文段落。 */
export function formatRoutingAdvice(advice: RoutingAdvice, tickets: readonly RoutingTicket[]): string {
  const byId = new Map(tickets.map(t => [t.id, t]))
  const lines: string[] = [
    '以下是代码对主人这句话做的「新任务 vs 续做旧工单」预分析（只在主人是在**提需求/要做事**时参考；纯查询、闲聊请忽略；事实以工具查询为准）：',
  ]
  if (advice.candidates.length > 0) {
    lines.push('相关旧工单（按相关度）：')
    advice.candidates.forEach((c, i) => {
      const ticket = byId.get(c.ticketId)
      const act = c.action === 'continue' ? '原地续做' : c.action === 'fork' ? '分叉承接' : '新建引用'
      lines.push(`  ${i + 1}. ${c.ticketId}「${c.title.slice(0, 30)}」[${ticket ? describeState(ticket) : c.state}] 相关度 ${Math.round(c.score * 100)}%（${c.reasons.join('；') || '弱相关'}）→ ${act}`)
    })
  }
  const label = advice.action === 'continue' ? '原地续做旧工单（ticket_manage → ticket_reply）'
    : advice.action === 'fork' ? '分叉承接旧工单（dispatch_ticket 填 fromTicketId）'
      : advice.action === 'new' ? '新建工单（dispatch_ticket）'
        : '拿不准，先问主人'
  lines.push(`系统建议：${label}${advice.ticketId && advice.action !== 'new' && advice.action !== 'ask' ? `，目标工单 ${advice.ticketId}` : ''}（把握 ${Math.round(advice.confidence * 100)}%）。理由：${advice.reason}。`)
  if (advice.action === 'ask') {
    lines.push(`执行方式：**不要擅自执行**。用一条简短消息说清候选和你的倾向，并在末尾原样附上：${advice.askLine}（系统会把引号里的选项变成可点击按钮；主人回复后按其选择执行，回复里的 8 位编号对应上面候选的完整编号）。`)
  } else if (advice.autoExecute) {
    lines.push('执行方式：低风险且有把握，**直接执行**，执行后用一句话告诉主人你选了续做/分叉/新建以及原因，主人觉得不对再纠正。')
  } else {
    lines.push('执行方式：涉及高风险动作，先用一条简短消息说明你打算怎么做并请主人确认，再动手。')
  }
  return lines.join('\n')
}

/** 路由所需的最小宿主能力（便于测试与解耦）。 */
export type RoutingHost = Pick<AdminHost, 'listTickets' | 'ticket'> & Partial<Pick<AdminHost, 'piConfigDir'>>

function stateOf(summary: TicketSummaryView): RoutingTicketState {
  if (summary.status === 'ended') return summary.outcome === 'stopped' ? 'stopped' : 'ended'
  return summary.needsPerson ? 'waiting_person' : 'running'
}

/** 从宿主取最近的工单并补全判断所需的细节：两阶段，先用标题粗筛，再只为入围者读取详情。 */
export function collectRoutingTickets(opts: {
  host: RoutingHost
  text: string
  focusTicketId?: string
  linkedTicketIds?: readonly string[]
  now: Date
  limit?: number
}): RoutingTicket[] {
  const recent = opts.host.listTickets({ status: 'all', limit: 60, offset: 0 }).items
  const request = tokenize(opts.text)
  const linked = opts.linkedTicketIds ?? []
  const prelim = recent.map(summary => {
    let score = 0.6 * Math.min(1, coverage(request, tokenize(summary.title)) * 2.5)
    if (summary.id === opts.focusTicketId) score += 0.4
    else if (linked.includes(summary.id)) score += 0.2
    const age = opts.now.getTime() - Date.parse(summary.updatedAt)
    if (Number.isFinite(age) && age < 24 * 3600_000) score += 0.05
    return { summary, score }
  }).sort((a, b) => b.score - a.score || b.summary.updatedAt.localeCompare(a.summary.updatedAt))
  const picked = prelim.slice(0, opts.limit ?? 8).map(item => item.summary)
  for (const id of [opts.focusTicketId, ...linked.slice(0, 2)]) {
    const summary = id ? recent.find(item => item.id === id) : undefined
    if (summary && !picked.includes(summary)) picked.push(summary)
  }
  const out: RoutingTicket[] = []
  for (const summary of picked) {
    let detail: TicketDetailView | undefined
    try { detail = opts.host.ticket(summary.id) } catch { detail = undefined }
    let hasSession = false
    try {
      const dir = opts.host.piConfigDir?.(summary.id)
      hasSession = dir ? listPiSessionFiles(dir).length > 0 : false
    } catch { hasSession = false }
    out.push({
      id: summary.id,
      title: summary.title,
      status: summary.status,
      state: stateOf(summary),
      updatedAt: summary.updatedAt,
      requestText: (detail?.prompt?.text ?? '').slice(0, 600),
      workspaceExists: detail?.workspace?.exists ?? false,
      hasSession,
    })
  }
  return out
}

/** 一步到位：采集 + 分析 + 渲染。 */
export function routeTask(opts: {
  host: RoutingHost
  text: string
  focusTicketId?: string
  linkedTicketIds?: readonly string[]
  now: Date
}): { advice: RoutingAdvice; tickets: RoutingTicket[]; prompt: string } {
  const tickets = collectRoutingTickets(opts)
  const advice = adviseTaskRouting({
    text: opts.text,
    tickets,
    ...(opts.focusTicketId ? { focusTicketId: opts.focusTicketId } : {}),
    ...(opts.linkedTicketIds ? { linkedTicketIds: opts.linkedTicketIds } : {}),
    now: opts.now,
  })
  return { advice, tickets, prompt: formatRoutingAdvice(advice, tickets) }
}
