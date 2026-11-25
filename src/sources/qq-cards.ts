/**
 * QQ 官方机器人消息排版优化与原生可点击按钮（Keyboard）构建器。
 *
 * 特性：
 * - 针对 QQ 手机端窄屏与纯文本渲染特性，将 Markdown 表格、标题、`#`/`**`/HTML 标签清理为干净易读的分段列表
 * - 支持高危操作确认、DAG 节点审批、密钥授权、工单重试/停止、会商按结论开工、小说改稿撤销的可点击回调按钮
 * - 支持从总控助手的自然语言回复中自动提取多选一建议，生成可点击的选择按钮，减少用户手动打字
 * - 紧凑回调载荷编码（<= 100 字节），超长文本选择项通过短期令牌映射保留完整语义
 */
import { randomBytes } from 'node:crypto'

export interface QqKeyboardButton {
  id: string
  render_data: {
    label: string
    visited_label?: string
    style?: 0 | 1
  }
  action: {
    type: 0 | 1 | 2
    data: string
    unsupport_tips?: string
    permission: {
      type: 0 | 1 | 2 | 3
      specify_user_ids?: string[]
    }
  }
}

export interface QqKeyboardRow {
  buttons: QqKeyboardButton[]
}

export interface QqKeyboard {
  id?: string
  content?: {
    rows: QqKeyboardRow[]
  }
}

export interface QqMarkdown {
  content?: string
  custom_template_id?: string
  params?: { key: string; values: string[] }[]
}

export interface QqRichMessagePayload {
  /** QQ 优化排版后的纯文本回退文案（始终保留，无权限自动降级时直接使用）。 */
  text: string
  /** 尝试原生 Markdown 渲染的内容（如开通高阶权限）。 */
  markdown?: QqMarkdown
  /** 原生可点击交互按钮布局（支持无权限自动降级）。 */
  keyboard?: QqKeyboard
}

export type QqInteractionAction =
  | { kind: 'director_action'; actionId: string; decision: 'approve' | 'reject' }
  | { kind: 'mission_approval'; missionId: string; nodeKey: string; planVersion: number; decision: 'approve' | 'cancel' }
  | { kind: 'vault_request'; requestId: string; decision: 'approve' | 'reject' }
  | { kind: 'ticket_op'; ticketId: string; op: 'retry' | 'stop' }
  | { kind: 'council_commit'; councilId: string }
  | { kind: 'novel_undo'; bookId: string; n: number }
  | { kind: 'choice'; text: string }
  | { kind: 'command'; text: string }

const CHOICE_TOKENS = new Map<string, string>()

function storeChoiceToken(text: string): string {
  const token = randomBytes(5).toString('hex')
  CHOICE_TOKENS.set(token, text)
  if (CHOICE_TOKENS.size > 500) {
    const first = CHOICE_TOKENS.keys().next().value
    if (first) CHOICE_TOKENS.delete(first)
  }
  return token
}

/** 编码互动按钮回调 `action.data`（尽量控制在 64~100 字节内以满足 QQ 开放平台限制）。 */
export function encodeQqAction(action: QqInteractionAction): string {
  switch (action.kind) {
    case 'director_action':
      return `da:${action.actionId}:${action.decision === 'approve' ? '1' : '0'}`
    case 'mission_approval':
      return `ma:${action.missionId}:${action.nodeKey}:${action.planVersion}:${action.decision === 'approve' ? '1' : '0'}`
    case 'vault_request':
      return `vr:${action.requestId}:${action.decision === 'approve' ? '1' : '0'}`
    case 'ticket_op':
      return `to:${action.ticketId}:${action.op === 'retry' ? 'r' : 's'}`
    case 'council_commit':
      return `cc:${action.councilId}`
    case 'novel_undo':
      return `nu:${action.bookId}:${action.n}`
    case 'command': {
      const encoded = `cm:${action.text.trim()}`
      if (Buffer.byteLength(encoded, 'utf8') <= 96) return encoded
      return `ck:${storeChoiceToken(action.text.trim())}`
    }
    case 'choice': {
      const clean = action.text.trim()
      const encoded = `ch:${clean}`
      if (Buffer.byteLength(encoded, 'utf8') <= 96) return encoded
      return `ck:${storeChoiceToken(clean)}`
    }
  }
}

/** 解码 QQ `INTERACTION_CREATE` 按钮回调中的 `data.tag` / `data.button_data` 载荷。 */
export function decodeQqAction(raw: string | undefined): QqInteractionAction | undefined {
  if (!raw || typeof raw !== 'string') return undefined
  const s = raw.trim()
  if (!s) return undefined

  if (s.startsWith('da:')) {
    const [, actionId, flag] = s.split(':')
    if (!actionId || (flag !== '1' && flag !== '0')) return undefined
    return { kind: 'director_action', actionId, decision: flag === '1' ? 'approve' : 'reject' }
  }
  if (s.startsWith('ma:')) {
    const parts = s.split(':')
    if (parts.length < 5) return undefined
    const missionId = parts[1]!
    const flag = parts[parts.length - 1]!
    const planVersion = Number(parts[parts.length - 2])
    const nodeKey = parts.slice(2, -2).join(':')
    if (!missionId || !nodeKey || !Number.isFinite(planVersion) || (flag !== '1' && flag !== '0')) return undefined
    return { kind: 'mission_approval', missionId, nodeKey, planVersion, decision: flag === '1' ? 'approve' : 'cancel' }
  }
  if (s.startsWith('vr:')) {
    const [, requestId, flag] = s.split(':')
    if (!requestId || (flag !== '1' && flag !== '0')) return undefined
    return { kind: 'vault_request', requestId, decision: flag === '1' ? 'approve' : 'reject' }
  }
  if (s.startsWith('to:')) {
    const [, ticketId, op] = s.split(':')
    if (!ticketId || (op !== 'r' && op !== 's')) return undefined
    return { kind: 'ticket_op', ticketId, op: op === 'r' ? 'retry' : 'stop' }
  }
  if (s.startsWith('cc:')) {
    const councilId = s.slice(3).trim()
    return councilId ? { kind: 'council_commit', councilId } : undefined
  }
  if (s.startsWith('nu:')) {
    const [, bookId, nStr] = s.split(':')
    const n = Number(nStr)
    if (!bookId || !Number.isInteger(n) || n <= 0) return undefined
    return { kind: 'novel_undo', bookId, n }
  }
  if (s.startsWith('cm:')) {
    const text = s.slice(3).trim()
    return text ? { kind: 'command', text } : undefined
  }
  if (s.startsWith('ch:')) {
    const text = s.slice(3).trim()
    return text ? { kind: 'choice', text } : undefined
  }
  if (s.startsWith('ck:')) {
    const text = CHOICE_TOKENS.get(s.slice(3).trim())
    return text ? { kind: 'choice', text } : undefined
  }
  return undefined
}

function clampLabel(label: string, max = 16): string {
  const clean = label.replace(/\s+/g, ' ').trim()
  const chars = Array.from(clean)
  return chars.length <= max ? clean : `${chars.slice(0, max - 1).join('')}…`
}

function makeButton(
  id: string,
  label: string,
  action: QqInteractionAction,
  opts: { style?: 0 | 1; visitedLabel?: string } = {},
): QqKeyboardButton {
  return {
    id,
    render_data: {
      label: clampLabel(label, 18),
      ...(opts.visitedLabel ? { visited_label: clampLabel(opts.visitedLabel, 18) } : {}),
      style: opts.style ?? 1,
    },
    action: {
      type: 1,
      data: encodeQqAction(action),
      unsupport_tips: '当前 QQ 版本暂不支持按钮交互，请升级 QQ 或直接回复文字指令',
      permission: { type: 2 },
    },
  }
}

function toKeyboard(rows: QqKeyboardButton[][]): QqKeyboard {
  return {
    content: {
      rows: rows
        .filter(r => r.length > 0)
        .map(buttons => ({ buttons })),
    },
  }
}

/** 将 Markdown 表格块转换为适合 QQ 手机端逐行阅读的项目符号列表。 */
function flattenMarkdownTables(text: string): string {
  const lines = text.split(/\r?\n/)
  const out: string[] = []
  let headers: string[] = []
  let inTable = false

  const splitCells = (line: string): string[] => {
    const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '')
    return trimmed.split('|').map(c => c.trim())
  }
  const isSeparator = (line: string): boolean => /^\s*\|?(?:\s*:?-{2,}:?\s*\|)+\s*:?-{2,}:?\s*\|?\s*$/.test(line)
  const isTableLine = (line: string): boolean => /^\s*\|.+\|\s*$/.test(line)

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!
    const next = lines[i + 1]
    if (!inTable && isTableLine(line) && next !== undefined && isSeparator(next)) {
      headers = splitCells(line)
      inTable = true
      i += 1
      continue
    }
    if (inTable) {
      if (!isTableLine(line)) {
        inTable = false
        headers = []
        out.push(line)
        continue
      }
      if (isSeparator(line)) continue
      const cells = splitCells(line)
      if (cells.length === 0) continue
      const primary = cells[0] || ''
      const rest = cells.slice(1).map((c, idx) => {
        const key = headers[idx + 1]
        return key ? `${key}：${c}` : c
      }).filter(Boolean)
      out.push(rest.length > 0 ? `• ${primary}（${rest.join('｜')}）` : `• ${primary}`)
      continue
    }
    out.push(line)
  }
  return out.join('\n')
}

/**
 * 针对 QQ 消息展示特性优化排版格式：
 * - `markdownMode = false`（QQ 默认纯文本 `msg_type: 0`）：去 HTML/Markdown 裸符号、把标题转成 `【标题】`、表格转列表、链接保留清晰 URL、合并冗余空行；
 * - `markdownMode = true`（QQ 原生 Markdown `msg_type: 2`）：清理飞书/HTML 标签并扁平化宽表格，保留粗体、列表与代码块。
 */
export function formatTextForQq(raw: string, opts: { markdownMode?: boolean } = {}): string {
  const cleanHtml = raw
    .replace(/<font[^>]*>([\s\S]*?)<\/font>/gi, '$1')
    .replace(/<\/?(?:br|hr)\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .trim()

  const withFlatTables = flattenMarkdownTables(cleanHtml)

  if (opts.markdownMode) {
    return withFlatTables
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  }

  // 纯文本模式：逐行清理代码块标记外层的 Markdown 语法，保留缩进与结构层次
  const lines = withFlatTables.split(/\r?\n/)
  const out: string[] = []
  let inFence = false

  for (const rawLine of lines) {
    const trimmed = rawLine.trim()
    if (trimmed.startsWith('```')) {
      inFence = !inFence
      out.push(inFence ? '── 代码/详情 ──' : '──────────')
      continue
    }
    if (inFence) {
      out.push(rawLine)
      continue
    }
    if (/^-{3,}$/.test(trimmed) || /^\*{3,}$/.test(trimmed)) {
      out.push('──────────')
      continue
    }
    const heading = /^#{1,6}\s+(.+)$/.exec(trimmed)
    if (heading) {
      const title = heading[1]!.replace(/\*\*(.+?)\*\*/g, '$1').replace(/`([^`]+)`/g, '$1').trim()
      if (out.length > 0 && out[out.length - 1] !== '') out.push('')
      out.push(`【${title}】`)
      continue
    }
    let line = rawLine
      .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '$1（$2）')
      .replace(/\*\*(.+?)\*\*/g, '$1')
      .replace(/__(.+?)__/g, '$1')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/^\s*>\s?/, '▏')
      .replace(/^(\s*)[-*]\s+/, '$1• ')
    out.push(line)
  }

  return out
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** 按段落与行边界切分超长 QQ 消息，避免截断半句。 */
export function splitForQq(text: string, maxChars = 1500): string[] {
  const clean = text.trim()
  if (!clean) return []
  if (clean.length <= maxChars) return [clean]
  const chunks: string[] = []
  let rest = clean
  while (rest.length > maxChars) {
    let cut = rest.lastIndexOf('\n\n', maxChars)
    if (cut < Math.floor(maxChars * 0.45)) cut = rest.lastIndexOf('\n', maxChars)
    if (cut < Math.floor(maxChars * 0.45)) cut = maxChars
    chunks.push(rest.slice(0, cut).trim())
    rest = rest.slice(cut).trim()
  }
  if (rest) chunks.push(rest)
  return chunks
}

/**
 * 从总控自然语言回复中智能识别多选一建议（如 `回复「继续」或「暂停」`、`方案 A / 方案 B`、`1. ... 2. ...`），
 * 提取为 2~4 个可直接点击的 QQ 回调按钮，用户点按钮即可直接决策无需打字。
 */
export function extractQqChoiceButtons(replyText: string): { label: string; text: string }[] {
  const text = replyText.trim()
  if (!text) return []

  // 1. 优先识别末尾提示行里的「动作A」「动作B」并列候选（如：请回复「确认」或「取消」 / 可选择「继续重试」/「先停掉」）
  const tailLines = text.split(/\r?\n/).slice(-8).join('\n')
  const quotedLineRe = /(?:回复|选择|发送|点选|直接说|建议|或者|还是)[^\n]{0,40}(?:[「『"']([^「『"'\n]{1,16})[」』"'])/g
  const tailHasChoiceHint = /(?:回复|选择|请决定|选哪|方案|确认|还是|或者)/.test(tailLines)
  if (tailHasChoiceHint) {
    const quoted: string[] = []
    for (const line of text.split(/\r?\n/).slice(-6)) {
      if (!/(?:回复|选择|请决定|选哪|还是|或者|是否)/.test(line)) continue
      const matches = [...line.matchAll(/[「『]([^「『」』\n]{1,16})[」』]/g)].map(m => m[1]!.trim())
      for (const m of matches) {
        if (!m || m.startsWith('/')) continue
        if (!quoted.includes(m)) quoted.push(m)
      }
    }
    if (quoted.length >= 2 && quoted.length <= 4) {
      return quoted.map(q => ({ label: q, text: q }))
    }
  }
  void quotedLineRe

  // 2. 识别列表形选项（仅当文中出现选择引导词时触发，避免把普通进度清单误变成按钮）
  const hasPromptAsk = /(?:请选择|选哪[一两]?个|以下.{0,6}方案|推荐.{0,6}方案|怎么处理|哪种方式|请确认下一步|你希望|请拍板)/.test(text)
  if (!hasPromptAsk) return []

  const candidates: { label: string; text: string }[] = []
  const seen = new Set<string>()
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim().replace(/\*\*/g, '')
    const m = /^(?:[-•*]\s*)?(?:(?:方案|选项)\s*([A-D1-4])|([A-D])[)）\.、]|([1-4])[)）\.、]|[①②③④])\s*[：:.\-–—]?\s*(.+)$/.exec(line)
    if (!m) continue
    const idxMap: Record<string, string> = { '①': '1', '②': '2', '③': '3', '④': '4' }
    const key = m[1] || m[2] || m[3] || idxMap[line[0] ?? ''] || ''
    const body = (m[4] || '').split(/[（(：:—\-|｜]/)[0]!.trim()
    if (!body || body.length > 24) continue
    const prefix = /^[A-D]$/.test(key) ? `方案${key}` : `选项${key}`
    const label = body.length <= 10 ? `${prefix}：${body}` : `${prefix} · ${body.slice(0, 8)}`
    const sendText = `${prefix}（${body}）`
    if (seen.has(prefix)) continue
    seen.add(prefix)
    candidates.push({ label, text: sendText })
    if (candidates.length >= 4) break
  }

  return candidates.length >= 2 ? candidates : []
}

/** 1. 高危操作二次确认消息（直接点按钮批准/拒绝）。 */
export function buildQqPendingActionPayload(input: {
  actionId: string
  toolName: string
  summary: string
  expiresAt?: string
  replyBody?: string
}): QqRichMessagePayload {
  const expireStr = input.expiresAt
    ? new Date(input.expiresAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
    : '10 分钟内'
  const lines = [
    ...(input.replyBody?.trim() ? [formatTextForQq(input.replyBody), '──────────'] : []),
    `🛡️ 待确认高危指令 #${input.actionId}`,
    `• 工具：${input.toolName}`,
    `• 摘要：${input.summary}`,
    `• 有效期至：${expireStr}`,
    '',
    `直接点击下方按钮执行；若无法点击，回复「/确认 ${input.actionId}」或「/取消 ${input.actionId}」。`,
  ]
  const text = lines.join('\n')
  const keyboard = toKeyboard([[
    makeButton(`da_ok_${input.actionId}`, `✅ 批准执行 #${input.actionId}`, {
      kind: 'director_action', actionId: input.actionId, decision: 'approve',
    }, { style: 1, visitedLabel: `已批准 #${input.actionId}` }),
    makeButton(`da_no_${input.actionId}`, '❌ 拒绝取消', {
      kind: 'director_action', actionId: input.actionId, decision: 'reject',
    }, { style: 0, visitedLabel: '已取消' }),
  ]])
  return {
    text,
    markdown: { content: `${input.replyBody?.trim() ? `${formatTextForQq(input.replyBody, { markdownMode: true })}\n\n---\n\n` : ''}**🛡️ 待确认高危指令 \`#${input.actionId}\`**\n- 工具：\`${input.toolName}\`\n- 摘要：${input.summary}\n- 有效期至：${expireStr}` },
    keyboard,
  }
}

/** 2. DAG 任务计划人工审批卡点消息。 */
export function buildQqMissionApprovalPayload(input: {
  missionId: string
  missionTitle: string
  nodeKey: string
  nodeTitle: string
  planVersion: number
  prompt?: string
  artifacts?: string[]
}): QqRichMessagePayload {
  const lines = [
    `🗺️ DAG 计划待人工批准：${input.missionTitle}`,
    `• 计划编号：${input.missionId}（v${input.planVersion}）`,
    `• 当前卡点：${input.nodeTitle}（${input.nodeKey}）`,
    ...(input.prompt?.trim() ? [`• 审批说明：${input.prompt.trim().slice(0, 400)}`] : []),
    ...(input.artifacts && input.artifacts.length > 0 ? [`• 前置产物：${input.artifacts.slice(0, 5).join('、')}`] : []),
    '',
    '点击下方按钮直接放行或取消，也可回复文字决策。',
  ]
  const keyboard = toKeyboard([[
    makeButton(`ma_ok_${input.nodeKey}`, '✅ 批准继续执行', {
      kind: 'mission_approval', missionId: input.missionId, nodeKey: input.nodeKey, planVersion: input.planVersion, decision: 'approve',
    }, { style: 1, visitedLabel: '已批准继续' }),
    makeButton(`ma_no_${input.nodeKey}`, '⛔ 取消计划', {
      kind: 'mission_approval', missionId: input.missionId, nodeKey: input.nodeKey, planVersion: input.planVersion, decision: 'cancel',
    }, { style: 0, visitedLabel: '已取消计划' }),
  ]])
  return { text: lines.join('\n'), keyboard }
}

/** 3. 密钥授权申请消息。 */
export function buildQqVaultRequestPayload(input: {
  requestId: string
  ticketId: string
  ticketTitle: string
  secretName: string
  why?: string
}): QqRichMessagePayload {
  const lines = [
    `🔑 密钥授权申请：${input.secretName}`,
    `• 工单：${input.ticketTitle}（${input.ticketId}）`,
    `• 申请原因：${input.why?.trim() || '工单执行需要访问凭据'}`,
    '',
    '点击下方按钮即可直接授权或拒绝。',
  ]
  const keyboard = toKeyboard([[
    makeButton(`vr_ok_${input.requestId}`, '✅ 批准授权', {
      kind: 'vault_request', requestId: input.requestId, decision: 'approve',
    }, { style: 1, visitedLabel: '已授权' }),
    makeButton(`vr_no_${input.requestId}`, '❌ 拒绝申请', {
      kind: 'vault_request', requestId: input.requestId, decision: 'reject',
    }, { style: 0, visitedLabel: '已拒绝' }),
  ]])
  return { text: lines.join('\n'), keyboard }
}

/** 4. 工单失败/阻塞/卡死决策消息。 */
export function buildQqTicketDecisionPayload(input: {
  ticketId: string
  title: string
  reason: string
  diagnosis: string
  attempts?: number
}): QqRichMessagePayload {
  const lines = [
    `🚨 需要你处理：${input.title}`,
    `• 工单编号：${input.ticketId}`,
    `• 状态原因：${input.reason}${input.attempts ? `（已自动排查 ${input.attempts} 轮）` : ''}`,
    '',
    formatTextForQq(input.diagnosis),
  ]
  const keyboard = toKeyboard([[
    makeButton(`tk_retry_${input.ticketId}`, '🔄 立即重试', {
      kind: 'ticket_op', ticketId: input.ticketId, op: 'retry',
    }, { style: 1, visitedLabel: '已触发重试' }),
    makeButton(`tk_stop_${input.ticketId}`, '🛑 停止工单', {
      kind: 'ticket_op', ticketId: input.ticketId, op: 'stop',
    }, { style: 0, visitedLabel: '已停止' }),
  ]])
  return { text: lines.join('\n'), keyboard }
}

/** 5. 多角色会商完成一键开工消息。 */
export function buildQqCouncilCompletedPayload(input: {
  councilId: string
  topic: string
  status: string
  brief?: string
  canCommit: boolean
}): QqRichMessagePayload {
  const ok = input.status === 'done'
  const lines = [
    `${ok ? '🏛️ 多角色会商已完成' : `⚠️ 会商已结束（${input.status}）`}：${input.topic.slice(0, 80)}`,
    `• 会商编号：${input.councilId}`,
    ...(input.brief ? ['', formatTextForQq(input.brief)] : []),
  ]
  const keyboard = input.canCommit
    ? toKeyboard([[
        makeButton(`cc_go_${input.councilId}`, '🚀 按结论直接开工', {
          kind: 'council_commit', councilId: input.councilId,
        }, { style: 1, visitedLabel: '已按结论开工' }),
        makeButton(`cc_st_${input.councilId}`, '📊 查看平台状态', {
          kind: 'command', text: '/状态',
        }, { style: 0 }),
      ]])
    : undefined
  return { text: lines.join('\n'), ...(keyboard ? { keyboard } : {}) }
}

/** 6. 小说改稿结束通知消息（含一键撤销按钮）。 */
export function buildQqNovelEditPayload(input: {
  bookId: string
  bookTitle: string
  n: number
  chapterTitle?: string
  status: 'done' | 'failed'
  note: string
  charsBefore?: number
  charsAfter?: number
  costUsd?: number
  error?: string
}): QqRichMessagePayload {
  const head = input.status === 'done'
    ? `✅ 《${input.bookTitle}》第 ${input.n} 章${input.chapterTitle ? `「${input.chapterTitle}」` : ''}改稿完成`
    : `❌ 《${input.bookTitle}》第 ${input.n} 章改稿未通过（原稿未改动）`
  const lines = [
    head,
    `• 修改意见：${input.note.slice(0, 120)}`,
    ...(input.status === 'done' && input.charsBefore !== undefined && input.charsAfter !== undefined
      ? [`• 篇幅变化：${input.charsBefore} 字 → ${input.charsAfter} 字`]
      : []),
    ...(input.costUsd !== undefined && input.costUsd > 0 ? [`• 本次花费：$${input.costUsd.toFixed(4)}`] : []),
    ...(input.error ? [`• 原因：${input.error}`] : []),
  ]
  const keyboard = input.status === 'done'
    ? toKeyboard([[
        makeButton(`nu_${input.n}`, `↩️ 撤销第 ${input.n} 章本次修改`, {
          kind: 'novel_undo', bookId: input.bookId, n: input.n,
        }, { style: 0, visitedLabel: '已撤销' }),
      ]])
    : undefined
  return { text: lines.join('\n'), ...(keyboard ? { keyboard } : {}) }
}

/** 7. 将总控回复中自动提取的多选项打包成 QQ 可点击选择按钮消息。 */
export function buildQqChoicePayload(text: string, choices: readonly { label: string; text: string }[]): QqRichMessagePayload {
  const formatted = formatTextForQq(text)
  const buttons = choices.slice(0, 4).map((c, idx) =>
    makeButton(`ch_${idx + 1}`, c.label, { kind: 'choice', text: c.text }, {
      style: idx === 0 ? 1 : 0,
    }),
  )
  const rows: QqKeyboardButton[][] = []
  for (let i = 0; i < buttons.length; i += 2) {
    rows.push(buttons.slice(i, i + 2))
  }
  return { text: formatted, keyboard: toKeyboard(rows) }
}
