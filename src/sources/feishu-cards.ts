/**
 * 飞书交互式卡片（Card JSON 2.0）构建与回调动作解析模块。
 *
 * 特性：
 * - 结构化 `column_set` 指标栏 + `hr` 视觉分隔 + 语义色标题 + 安全 Markdown 截断（绝不截断代码块）
 * - 覆盖全链路推送与交互：高危指令确认、DAG 节点审批、密钥授权、工单完工/异常/等待决策、会商结论一键开工、预算/主机告警与里程碑播报
 * - 所有按钮回调均携带强类型 `value` 负载，兼容长连接 WS 与 HTTP Webhook 双模式
 */

export type FeishuCardTemplate = 'blue' | 'wathet' | 'turquoise' | 'green' | 'yellow' | 'orange' | 'red' | 'carmine' | 'violet' | 'purple' | 'indigo' | 'grey'

export type FeishuCardActionValue =
  | { kind: 'director_action'; actionId: string; decision: 'approve' | 'reject' }
  | { kind: 'mission_approval'; missionId: string; nodeKey: string; planVersion: number; decision: 'approve' | 'cancel'; title?: string }
  | { kind: 'vault_request'; requestId: string; ticketId: string; secretName: string; decision: 'approve' | 'reject' }
  | { kind: 'ticket_op'; ticketId: string; op: 'retry' | 'stop'; title?: string }
  | { kind: 'council_commit'; councilId: string; title?: string }

export interface FeishuCardActionEvent {
  operatorOpenId: string
  openMessageId?: string
  openChatId?: string
  token?: string
  actionValue: FeishuCardActionValue
}

export interface FeishuCardCallbackResponse {
  toast?: {
    type: 'info' | 'success' | 'warning' | 'error'
    content: string
  }
  card?: {
    type: 'raw'
    data: Record<string, unknown>
  }
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function trimText(text: string, max: number): string {
  const s = text.trim()
  if (s.length <= max) return s
  const sliced = s.slice(0, Math.max(20, max - 12))
  // 避免把未闭合的 ``` 代码块截断在卡片里导致飞书排版错乱
  const fences = (sliced.match(/```/g) ?? []).length
  return fences % 2 === 1 ? `${sliced}\n\`\`\`\n…` : `${sliced}…`
}

function cardShell(
  title: string,
  template: FeishuCardTemplate,
  elements: Record<string, unknown>[],
  subtitle?: string,
): Record<string, unknown> {
  return {
    schema: '2.0',
    config: {
      update_multi: true,
      wide_screen_mode: true,
    },
    header: {
      template,
      title: { tag: 'plain_text', content: trimText(title, 96) },
      ...(subtitle ? { subtitle: { tag: 'plain_text', content: trimText(subtitle, 96) } } : {}),
    },
    body: {
      elements,
    },
  }
}

function metaColumns(items: { label: string; value: string }[]): Record<string, unknown> {
  return {
    tag: 'column_set',
    flex_mode: 'bisect',
    background_style: 'grey',
    horizontal_spacing: 'small',
    columns: items.map(item => ({
      tag: 'column',
      width: 'weighted',
      weight: 1,
      elements: [
        {
          tag: 'markdown',
          content: `<font color="grey">${item.label}</font>\n**${trimText(item.value, 60)}**`,
        },
      ],
    })),
  }
}

function buttonRow(buttons: {
  label: string
  type: 'primary' | 'default' | 'danger'
  value: FeishuCardActionValue
}[]): Record<string, unknown> {
  return {
    tag: 'column_set',
    flex_mode: 'none',
    horizontal_spacing: 'small',
    columns: buttons.map(btn => ({
      tag: 'column',
      width: 'auto',
      elements: [
        {
          tag: 'button',
          text: { tag: 'plain_text', content: btn.label },
          type: btn.type,
          size: 'medium',
          behaviors: [{ type: 'callback', value: btn.value }],
        },
      ],
    })),
  }
}

/** 1. 总控高危操作二次确认卡片（如宿主机命令、重启服务、改配置、切换镜像）。 */
export function buildPendingActionCard(input: {
  actionId: string
  toolName: string
  summary: string
  expiresAt?: string
  replyBody?: string
}): Record<string, unknown> {
  const expireStr = input.expiresAt
    ? new Date(input.expiresAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
    : '10 分钟内'
  const elements: Record<string, unknown>[] = []
  if (input.replyBody?.trim()) {
    elements.push({ tag: 'markdown', content: trimText(input.replyBody, 1800) })
    elements.push({ tag: 'hr' })
  }
  elements.push(metaColumns([
    { label: '确认短码', value: `#${input.actionId}` },
    { label: '高危工具', value: input.toolName },
    { label: '有效期至', value: expireStr },
  ]))
  elements.push({
    tag: 'markdown',
    content: `**操作详情**\n${trimText(input.summary, 600)}`,
  })
  elements.push(buttonRow([
    {
      label: `批准执行 #${input.actionId}`,
      type: 'primary',
      value: { kind: 'director_action', actionId: input.actionId, decision: 'approve' },
    },
    {
      label: '拒绝取消',
      type: 'danger',
      value: { kind: 'director_action', actionId: input.actionId, decision: 'reject' },
    },
  ]))
  elements.push({
    tag: 'markdown',
    content: `<font color="grey">也可直接回复文字「/确认 ${input.actionId}」或「/取消 ${input.actionId}」</font>`,
  })
  return cardShell(`待确认高危指令 #${input.actionId}`, 'orange', elements, '需要主人授权后方可执行')
}

/** 2. DAG 计划人工审批卡点卡片。 */
export function buildMissionApprovalCard(input: {
  missionId: string
  missionTitle: string
  nodeKey: string
  nodeTitle: string
  planVersion: number
  prompt?: string
  artifacts?: string[]
}): Record<string, unknown> {
  const elements: Record<string, unknown>[] = [
    metaColumns([
      { label: 'DAG 计划', value: `${input.missionId} · v${input.planVersion}` },
      { label: '当前卡点', value: `${input.nodeTitle} (${input.nodeKey})` },
    ]),
  ]
  const details: string[] = []
  if (input.prompt?.trim()) details.push(`**审批说明**\n${trimText(input.prompt, 700)}`)
  if (input.artifacts && input.artifacts.length > 0) {
    details.push(`**已有交付物**\n${input.artifacts.slice(0, 6).map(a => `- \`${a}\``).join('\n')}`)
  }
  if (details.length > 0) {
    elements.push({ tag: 'markdown', content: details.join('\n\n') })
  }
  elements.push({ tag: 'hr' })
  elements.push(buttonRow([
    {
      label: '批准继续执行',
      type: 'primary',
      value: {
        kind: 'mission_approval',
        missionId: input.missionId,
        nodeKey: input.nodeKey,
        planVersion: input.planVersion,
        decision: 'approve',
        title: input.missionTitle,
      },
    },
    {
      label: '取消此计划',
      type: 'danger',
      value: {
        kind: 'mission_approval',
        missionId: input.missionId,
        nodeKey: input.nodeKey,
        planVersion: input.planVersion,
        decision: 'cancel',
        title: input.missionTitle,
      },
    },
  ]))
  return cardShell(`任务计划待审批：${input.missionTitle}`, 'indigo', elements, '人工门禁卡点')
}

/** 3. 密钥使用申请一键审批卡片。 */
export function buildVaultRequestCard(input: {
  requestId: string
  ticketId: string
  ticketTitle?: string
  secretName: string
  reason?: string
  why?: string
}): Record<string, unknown> {
  const whyText = (input.why ?? input.reason ?? '').trim()
  const elements: Record<string, unknown>[] = [
    metaColumns([
      { label: '申请密钥', value: input.secretName },
      { label: '来源工单', value: input.ticketTitle ? `${input.ticketTitle} (${input.ticketId})` : input.ticketId },
    ]),
  ]
  if (whyText) {
    elements.push({ tag: 'markdown', content: `**申请用途**\n${trimText(whyText, 500)}` })
  }
  elements.push({ tag: 'hr' })
  elements.push(buttonRow([
    {
      label: '批准授权使用',
      type: 'primary',
      value: {
        kind: 'vault_request',
        requestId: input.requestId,
        ticketId: input.ticketId,
        secretName: input.secretName,
        decision: 'approve',
      },
    },
    {
      label: '拒绝申请',
      type: 'danger',
      value: {
        kind: 'vault_request',
        requestId: input.requestId,
        ticketId: input.ticketId,
        secretName: input.secretName,
        decision: 'reject',
      },
    },
  ]))
  return cardShell(`密钥授权申请：${input.secretName}`, 'yellow', elements, '仅授权给当前工单容器')
}

/** 4. 工单异常/自愈耗尽时的决策卡片（支持一键重试或停止）。 */
export function buildTicketDecisionCard(input: {
  ticketId: string
  title: string
  reason: string
  diagnosis?: string
  attempts?: number
  showRetry?: boolean
}): Record<string, unknown> {
  const meta: { label: string; value: string }[] = [
    { label: '工单编号', value: input.ticketId },
    { label: '异常原因', value: trimText(input.reason, 48) },
  ]
  if (typeof input.attempts === 'number' && input.attempts > 0) {
    meta.push({ label: '自动排障', value: `已尝试 ${input.attempts} 轮` })
  }
  const elements: Record<string, unknown>[] = [metaColumns(meta)]
  if (input.diagnosis?.trim()) {
    elements.push({ tag: 'markdown', content: `**排查与建议**\n${trimText(input.diagnosis, 1100)}` })
  }
  elements.push({ tag: 'hr' })
  const btns: { label: string; type: 'primary' | 'default' | 'danger'; value: FeishuCardActionValue }[] = []
  if (input.showRetry !== false) {
    btns.push({
      label: '重新尝试执行',
      type: 'primary',
      value: { kind: 'ticket_op', ticketId: input.ticketId, op: 'retry', title: input.title },
    })
  }
  btns.push({
    label: '停止此工单',
    type: 'danger',
    value: { kind: 'ticket_op', ticketId: input.ticketId, op: 'stop', title: input.title },
  })
  elements.push(buttonRow(btns))
  elements.push({
    tag: 'markdown',
    content: '<font color="grey">也可直接回复文字补充上下文或改变执行方案</font>',
  })
  return cardShell(`需要拍板：${input.title}`, 'red', elements, '总控已尽力自愈，请决定下一步')
}

/** 5. 工单完工交付战报卡片（结构化指标栏 + 摘要 + 预览链接 + 失败时一键重试）。 */
export function buildTicketCompletedCard(input: {
  ticketId: string
  title: string
  outcome: string
  summary?: string
  costUsd?: number
  previews?: { url: string; title?: string }[]
}): Record<string, unknown> {
  const ok = input.outcome === 'completed'
  const failed = input.outcome === 'failed'
  const outcomeWord = ok ? '已完成' : failed ? '执行失败' : input.outcome === 'stopped' ? '已停止' : input.outcome
  const template: FeishuCardTemplate = ok ? 'green' : failed ? 'red' : 'grey'
  const meta: { label: string; value: string }[] = [
    { label: '工单编号', value: input.ticketId },
    { label: '终态', value: outcomeWord },
  ]
  if (typeof input.costUsd === 'number' && input.costUsd > 0) {
    meta.push({ label: '本次花费', value: `$${input.costUsd.toFixed(4)}` })
  }
  const elements: Record<string, unknown>[] = [metaColumns(meta)]
  if (input.summary?.trim()) {
    elements.push({ tag: 'markdown', content: trimText(input.summary, 1800) })
  }
  const validPreviews = (input.previews ?? []).filter(p => /^https?:\/\//.test(p.url)).slice(0, 3)
  if (validPreviews.length > 0) {
    elements.push({ tag: 'hr' })
    elements.push({
      tag: 'markdown',
      content: `**在线预览与交付链接**\n${validPreviews.map(p => `- [${p.title || p.url}](${p.url})`).join('\n')}`,
    })
  }
  if (!ok) {
    elements.push({ tag: 'hr' })
    elements.push(buttonRow([
      {
        label: '一键重试工单',
        type: 'primary',
        value: { kind: 'ticket_op', ticketId: input.ticketId, op: 'retry', title: input.title },
      },
    ]))
  }
  elements.push({
    tag: 'markdown',
    content: `<font color="grey">直接回复本消息可围绕工单 \`${input.ticketId}\` 继续追问或追加需求</font>`,
  })
  return cardShell(`${ok ? '任务已交付' : `任务${outcomeWord}`}：${input.title}`, template, elements)
}

/** 6. 工单等待主人回复卡片（清晰突出提问 + 快速操作）。 */
export function buildTicketAttentionCard(input: {
  ticketId: string
  title: string
  kind: string
  question?: string
}): Record<string, unknown> {
  const elements: Record<string, unknown>[] = [
    metaColumns([
      { label: '工单编号', value: input.ticketId },
      { label: '暂停原因', value: input.kind || '等待确认' },
    ]),
    {
      tag: 'markdown',
      content: `**执行者提问**\n${trimText(input.question || '任务已暂停，请给出进一步指引。', 1200)}`,
    },
    { tag: 'hr' },
    buttonRow([
      {
        label: '停止此工单',
        type: 'danger',
        value: { kind: 'ticket_op', ticketId: input.ticketId, op: 'stop', title: input.title },
      },
    ]),
    {
      tag: 'markdown',
      content: '<font color="grey">直接回复文字即可将答案注入工单并自动唤醒继续执行</font>',
    },
  ]
  return cardShell(`等待回复：${input.title}`, 'orange', elements, '需要你补充信息或做决策')
}

/** 7. 多角色会商完成卡片（附一键按结论开工按钮）。 */
export function buildCouncilCompletedCard(input: {
  councilId: string
  topic: string
  status: string
  brief?: string
  costUsd?: number
  canCommit?: boolean
}): Record<string, unknown> {
  const ok = input.status === 'done'
  const meta: { label: string; value: string }[] = [
    { label: '会商编号', value: input.councilId },
    { label: '状态', value: ok ? '已出结论' : input.status },
  ]
  if (typeof input.costUsd === 'number' && input.costUsd > 0) {
    meta.push({ label: '会商花费', value: `$${input.costUsd.toFixed(4)}` })
  }
  const elements: Record<string, unknown>[] = [metaColumns(meta)]
  if (input.brief?.trim()) {
    elements.push({ tag: 'markdown', content: `**任务书 / 结论摘要**\n${trimText(input.brief, 1600)}` })
  }
  if (ok && input.canCommit !== false) {
    elements.push({ tag: 'hr' })
    elements.push(buttonRow([
      {
        label: '按结论一键开工',
        type: 'primary',
        value: { kind: 'council_commit', councilId: input.councilId, title: input.topic },
      },
    ]))
  }
  return cardShell(`多角色会商完成：${input.topic}`, ok ? 'purple' : 'grey', elements)
}

/** 8. 系统/预算/里程碑结构化通知卡片。 */
export function buildNoticeCard(input: {
  title: string
  subtitle?: string
  template: FeishuCardTemplate
  meta?: { label: string; value: string }[]
  markdown: string
  footnote?: string
}): Record<string, unknown> {
  const elements: Record<string, unknown>[] = []
  if (input.meta && input.meta.length > 0) elements.push(metaColumns(input.meta))
  elements.push({ tag: 'markdown', content: trimText(input.markdown, 2000) })
  if (input.footnote) {
    elements.push({ tag: 'hr' })
    elements.push({ tag: 'markdown', content: `<font color="grey">${trimText(input.footnote, 200)}</font>` })
  }
  return cardShell(input.title, input.template, elements, input.subtitle)
}

/** 9. 操作完成后的终态卡片（原位替换旧卡片，隐藏按钮防重复点击）。 */
export function buildSettledCard(input: {
  title: string
  template: FeishuCardTemplate
  markdown: string
  statusLine: string
}): Record<string, unknown> {
  return cardShell(input.title, input.template, [
    { tag: 'markdown', content: trimText(input.markdown, 2400) },
    { tag: 'hr' },
    { tag: 'markdown', content: `**${input.statusLine}**` },
  ])
}

/**
 * 兼容解析飞书长连接（WS `card.action.trigger`）与 HTTP Webhook（2.0 / 1.0）传回的卡片点击事件。
 */
export function parseFeishuCardActionEvent(raw: unknown): FeishuCardActionEvent | undefined {
  if (!isObj(raw)) return undefined
  const body = isObj(raw.event) ? raw.event : raw
  const operator = isObj(body.operator) ? body.operator : undefined
  const operatorOpenId =
    (typeof operator?.open_id === 'string' && operator.open_id)
    || (typeof body.open_id === 'string' && body.open_id)
    || ''
  if (!operatorOpenId) return undefined

  const action = isObj(body.action) ? body.action : undefined
  const rawVal = action?.value
  let valObj: Record<string, unknown> | undefined
  if (isObj(rawVal)) {
    valObj = rawVal
  } else if (typeof rawVal === 'string') {
    try {
      const parsed = JSON.parse(rawVal)
      if (isObj(parsed)) valObj = parsed
    } catch {
      return undefined
    }
  }
  if (!valObj) return undefined

  const actionValue = parseActionValue(valObj)
  if (!actionValue) return undefined

  const header = isObj(raw.header) ? raw.header : undefined
  const eventId =
    (typeof header?.event_id === 'string' && header.event_id)
    || (typeof raw.event_id === 'string' && raw.event_id)
    || (typeof body.event_id === 'string' && body.event_id)
    || undefined
  const context = isObj(body.context) ? body.context : undefined
  const openMessageId =
    (typeof context?.open_message_id === 'string' && context.open_message_id)
    || (typeof body.open_message_id === 'string' && body.open_message_id)
    || undefined
  const openChatId =
    (typeof context?.open_chat_id === 'string' && context.open_chat_id)
    || (typeof body.open_chat_id === 'string' && body.open_chat_id)
    || undefined
  const token = typeof body.token === 'string' ? body.token : undefined

  return {
    ...(eventId ? { eventId } : {}),
    operatorOpenId,
    ...(openMessageId ? { openMessageId } : {}),
    ...(openChatId ? { openChatId } : {}),
    ...(token ? { token } : {}),
    actionValue,
  }
}

function parseActionValue(v: Record<string, unknown>): FeishuCardActionValue | undefined {
  const kind = typeof v.kind === 'string' ? v.kind : ''
  if (kind === 'director_action') {
    const actionId = typeof v.actionId === 'string' ? v.actionId.trim() : ''
    const decision = v.decision === 'approve' || v.decision === 'reject' ? v.decision : undefined
    if (!actionId || !decision) return undefined
    return { kind: 'director_action', actionId, decision }
  }
  if (kind === 'mission_approval') {
    const missionId = typeof v.missionId === 'string' ? v.missionId.trim() : ''
    const nodeKey = typeof v.nodeKey === 'string' ? v.nodeKey.trim() : ''
    const planVersion = typeof v.planVersion === 'number' && Number.isFinite(v.planVersion)
      ? Math.floor(v.planVersion)
      : Number(v.planVersion)
    const decision = v.decision === 'approve' || v.decision === 'cancel' ? v.decision : undefined
    if (!missionId || !nodeKey || !Number.isFinite(planVersion) || !decision) return undefined
    const title = typeof v.title === 'string' ? v.title : undefined
    return { kind: 'mission_approval', missionId, nodeKey, planVersion, decision, ...(title ? { title } : {}) }
  }
  if (kind === 'vault_request') {
    const requestId = typeof v.requestId === 'string' ? v.requestId.trim() : ''
    const ticketId = typeof v.ticketId === 'string' ? v.ticketId.trim() : ''
    const secretName = typeof v.secretName === 'string' ? v.secretName.trim() : ''
    const decision = v.decision === 'approve' || v.decision === 'reject' ? v.decision : undefined
    if (!requestId || !decision) return undefined
    return { kind: 'vault_request', requestId, ticketId, secretName, decision }
  }
  if (kind === 'ticket_op') {
    const ticketId = typeof v.ticketId === 'string' ? v.ticketId.trim() : ''
    const op = v.op === 'retry' || v.op === 'stop' ? v.op : undefined
    if (!ticketId || !op) return undefined
    const title = typeof v.title === 'string' ? v.title : undefined
    return { kind: 'ticket_op', ticketId, op, ...(title ? { title } : {}) }
  }
  if (kind === 'council_commit') {
    const councilId = typeof v.councilId === 'string' ? v.councilId.trim() : ''
    if (!councilId) return undefined
    const title = typeof v.title === 'string' ? v.title : undefined
    return { kind: 'council_commit', councilId, ...(title ? { title } : {}) }
  }
  return undefined
}
