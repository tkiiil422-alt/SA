/**
 * 飞书交互卡片（Card JSON 2.0）构建与回调事件解析。
 *
 * 用于总控助手的四类人工拍板场景（支持飞书长连接 `WSClient` 与 HTTP Webhook 双通道）：
 * 1. L3 高危操作确认（`director_action`）：一键批准或拒绝宿主机/部署/改配置等指令
 * 2. DAG 计划节点人工审批（`mission_approval`）：一键批准继续或取消计划
 * 3. 密钥使用授权申请（`vault_request`）：一键批准或拒绝工单密钥请求
 * 4. 故障自愈受阻人工决策（`ticket_op`）：一键重试或停止异常工单
 *
 * 点击按钮后 3 秒内即时返回 `{ toast, card }` 锁定卡片状态防连点，后台异步执行完成后再调用
 * `PATCH /open-apis/im/v1/messages/:message_id` 更新最终结果。
 */

export type FeishuCardHeaderTemplate = 'blue' | 'wathet' | 'turquoise' | 'green' | 'yellow' | 'orange' | 'red' | 'carmine' | 'violet' | 'purple' | 'indigo' | 'grey'

export type FeishuCardActionValue =
  | {
    kind: 'director_action'
    actionId: string
    decision: 'approve' | 'reject'
    summary?: string
  }
  | {
    kind: 'mission_approval'
    missionId: string
    nodeKey: string
    planVersion: number
    decision: 'approve' | 'cancel'
    title?: string
  }
  | {
    kind: 'vault_request'
    requestId: string
    ticketId: string
    secretName: string
    decision: 'approve' | 'reject'
  }
  | {
    kind: 'ticket_op'
    ticketId: string
    op: 'retry' | 'stop'
    title?: string
  }

export interface FeishuCardActionEvent {
  eventId?: string
  operatorOpenId: string
  openMessageId?: string
  openChatId?: string
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

interface CardButtonSpec {
  label: string
  style: 'primary' | 'danger' | 'default'
  value: FeishuCardActionValue
}

function makeButtonColumn(btn: CardButtonSpec): Record<string, unknown> {
  return {
    tag: 'column',
    width: 'auto',
    elements: [
      {
        tag: 'button',
        text: { tag: 'plain_text', content: btn.label },
        type: btn.style,
        behaviors: [
          {
            type: 'callback',
            value: btn.value,
          },
        ],
      },
    ],
  }
}

function buildInteractiveCard(input: {
  title: string
  subtitle?: string
  template: FeishuCardHeaderTemplate
  markdown: string
  buttons?: readonly CardButtonSpec[]
  note?: string
}): Record<string, unknown> {
  const elements: Record<string, unknown>[] = [
    { tag: 'markdown', content: input.markdown.slice(0, 6000) },
  ]
  if (input.buttons && input.buttons.length > 0) {
    elements.push({
      tag: 'column_set',
      flex_mode: 'none',
      horizontal_spacing: 'small',
      columns: input.buttons.map(makeButtonColumn),
    })
  }
  if (input.note) {
    elements.push({ tag: 'hr' })
    elements.push({ tag: 'markdown', content: `<font color="grey">${input.note}</font>` })
  }
  return {
    schema: '2.0',
    config: {
      wide_screen_mode: true,
      update_multi: true,
    },
    header: {
      template: input.template,
      title: { tag: 'plain_text', content: input.title.slice(0, 100) },
      ...(input.subtitle ? { subtitle: { tag: 'plain_text', content: input.subtitle.slice(0, 100) } } : {}),
    },
    body: {
      elements,
    },
  }
}

/** 场景 1：L3 高危操作一键确认卡片（支持附带总控正文说明）。 */
export function buildPendingActionCard(input: {
  actionId: string
  toolName: string
  summary: string
  expiresAt?: string
  replyBody?: string
}): Record<string, unknown> {
  const lines: string[] = []
  if (input.replyBody?.trim()) {
    lines.push(input.replyBody.trim(), '', '---')
  }
  lines.push(
    `**待确认高危操作** \`#${input.actionId}\``,
    `**工具**：\`${input.toolName}\``,
    `**摘要**：${input.summary}`,
  )
  if (input.expiresAt) {
    const t = new Date(input.expiresAt)
    if (!Number.isNaN(t.getTime())) {
      lines.push(`**有效截止**：${t.toLocaleTimeString('zh-CN', { hour12: false })}`)
    }
  }
  return buildInteractiveCard({
    title: `待确认高危指令 #${input.actionId}`,
    subtitle: '点击按钮直接批准或拒绝',
    template: 'orange',
    markdown: lines.join('\n'),
    buttons: [
      {
        label: '✅ 确认执行',
        style: 'primary',
        value: { kind: 'director_action', actionId: input.actionId, decision: 'approve', summary: input.summary.slice(0, 120) },
      },
      {
        label: '❌ 拒绝',
        style: 'danger',
        value: { kind: 'director_action', actionId: input.actionId, decision: 'reject', summary: input.summary.slice(0, 120) },
      },
    ],
    note: `若飞书应用尚未开启卡片回传交互，直接回复「/确认 ${input.actionId}」或「/取消 ${input.actionId}」同样生效。`,
  })
}

/** 场景 2：DAG 任务计划人工审批节点卡片。 */
export function buildMissionApprovalCard(input: {
  missionId: string
  missionTitle: string
  nodeKey: string
  nodeTitle: string
  planVersion: number
  prompt?: string
  artifacts?: readonly string[]
}): Record<string, unknown> {
  const lines = [
    `**任务计划**：${input.missionTitle}（\`${input.missionId}\` · v${input.planVersion}）`,
    `**待审批节点**：${input.nodeTitle}（\`${input.nodeKey}\`）`,
  ]
  if (input.prompt?.trim()) lines.push('', input.prompt.trim().slice(0, 800))
  if (input.artifacts && input.artifacts.length > 0) {
    lines.push('', `**前置产物**：${input.artifacts.slice(0, 5).map(a => `\`${a}\``).join('、')}`)
  }
  return buildInteractiveCard({
    title: `DAG 计划等待批准 (v${input.planVersion})`,
    subtitle: input.missionTitle,
    template: 'blue',
    markdown: lines.join('\n'),
    buttons: [
      {
        label: `✅ 批准继续 (v${input.planVersion})`,
        style: 'primary',
        value: {
          kind: 'mission_approval',
          missionId: input.missionId,
          nodeKey: input.nodeKey,
          planVersion: input.planVersion,
          decision: 'approve',
          title: `${input.missionTitle} / ${input.nodeTitle}`.slice(0, 120),
        },
      },
      {
        label: '🚫 取消计划',
        style: 'danger',
        value: {
          kind: 'mission_approval',
          missionId: input.missionId,
          nodeKey: input.nodeKey,
          planVersion: input.planVersion,
          decision: 'cancel',
          title: `${input.missionTitle} / ${input.nodeTitle}`.slice(0, 120),
        },
      },
    ],
    note: `也可直接回复总控「批准计划 ${input.missionId} 的 ${input.nodeKey} 节点」。`,
  })
}

/** 场景 3：工单密钥授权申请卡片。 */
export function buildVaultRequestCard(input: {
  requestId: string
  ticketId: string
  ticketTitle: string
  secretName: string
  why: string
}): Record<string, unknown> {
  const lines = [
    `**工单**：${input.ticketTitle}（\`${input.ticketId}\`）`,
    `**申请密钥**：\`${input.secretName}\``,
    `**申请理由**：${input.why || '未说明'}`,
  ]
  return buildInteractiveCard({
    title: `任务申请使用密钥：${input.secretName}`,
    subtitle: input.ticketTitle,
    template: 'orange',
    markdown: lines.join('\n'),
    buttons: [
      {
        label: '✅ 批准授权',
        style: 'primary',
        value: { kind: 'vault_request', requestId: input.requestId, ticketId: input.ticketId, secretName: input.secretName, decision: 'approve' },
      },
      {
        label: '❌ 拒绝',
        style: 'danger',
        value: { kind: 'vault_request', requestId: input.requestId, ticketId: input.ticketId, secretName: input.secretName, decision: 'reject' },
      },
    ],
    note: '也可以回复总控「批准这个密钥申请」或前往控制台密钥页处理。',
  })
}

/** 场景 4：自愈受阻或异常工单升级决策卡片。 */
export function buildTicketDecisionCard(input: {
  ticketId: string
  title: string
  reason: string
  diagnosis: string
  attempts?: number
}): Record<string, unknown> {
  const lines = [
    `**工单**：${input.title}（\`${input.ticketId}\`）`,
    `**异常类型**：${input.reason}${input.attempts ? `（总控已自动排查修复 ${input.attempts} 轮）` : ''}`,
    '',
    input.diagnosis.trim().slice(0, 1800),
  ]
  return buildInteractiveCard({
    title: `任务需要你拍板：${input.title.slice(0, 48)}`,
    subtitle: `工单 ${input.ticketId.slice(0, 12)}`,
    template: 'red',
    markdown: lines.join('\n'),
    buttons: [
      {
        label: '🔄 重新执行一次',
        style: 'primary',
        value: { kind: 'ticket_op', ticketId: input.ticketId, op: 'retry', title: input.title.slice(0, 100) },
      },
      {
        label: '⏹ 停止任务',
        style: 'danger',
        value: { kind: 'ticket_op', ticketId: input.ticketId, op: 'stop', title: input.title.slice(0, 100) },
      },
    ],
    note: '也可直接文字回复你的补充信息或新思路，总控会立刻转达并继续推进。',
  })
}

/** 按钮点击后返回的已锁定状态卡片（移除所有按钮，防止重复点击）。 */
export function buildSettledCard(input: {
  title: string
  template: FeishuCardHeaderTemplate
  markdown: string
  statusLine: string
}): Record<string, unknown> {
  return buildInteractiveCard({
    title: input.title,
    template: input.template,
    markdown: `${input.markdown.trim()}\n\n---\n${input.statusLine}`,
  })
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/**
 * 解析飞书 `card.action.trigger` 原始回调载荷（同时兼容长连接 WS 2.0 与 HTTP Webhook 1.0/2.0 结构）。
 */
export function parseFeishuCardActionEvent(raw: unknown): FeishuCardActionEvent | undefined {
  if (!isRecord(raw)) return undefined
  // 长连接 SDK 的 EventDispatcher 传入的是剥离 header 后的 event 对象（或带 header 的完整载荷）
  const header = isRecord(raw.header) ? raw.header : undefined
  const body = isRecord(raw.event) ? raw.event : raw

  const operator = isRecord(body.operator) ? body.operator : undefined
  const operatorOpenId = typeof operator?.open_id === 'string' && operator.open_id.trim()
    ? operator.open_id.trim()
    : (typeof body.open_id === 'string' && body.open_id.trim() ? body.open_id.trim() : '')
  if (!operatorOpenId) return undefined

  const context = isRecord(body.context) ? body.context : undefined
  const openMessageId = typeof context?.open_message_id === 'string'
    ? context.open_message_id
    : (typeof body.open_message_id === 'string' ? body.open_message_id : undefined)
  const openChatId = typeof context?.open_chat_id === 'string'
    ? context.open_chat_id
    : (typeof body.open_chat_id === 'string' ? body.open_chat_id : undefined)

  const action = isRecord(body.action) ? body.action : undefined
  let val: unknown = action?.value
  if (typeof val === 'string') {
    try { val = JSON.parse(val) } catch { return undefined }
  }
  if (!isRecord(val) || typeof val.kind !== 'string') return undefined

  const eventId = typeof header?.event_id === 'string'
    ? header.event_id
    : (typeof raw.event_id === 'string' ? raw.event_id : undefined)

  let actionValue: FeishuCardActionValue | undefined
  if (val.kind === 'director_action' && typeof val.actionId === 'string' && (val.decision === 'approve' || val.decision === 'reject')) {
    actionValue = {
      kind: 'director_action',
      actionId: val.actionId.trim(),
      decision: val.decision,
      ...(typeof val.summary === 'string' ? { summary: val.summary } : {}),
    }
  } else if (
    val.kind === 'mission_approval'
    && typeof val.missionId === 'string'
    && typeof val.nodeKey === 'string'
    && typeof val.planVersion === 'number'
    && (val.decision === 'approve' || val.decision === 'cancel')
  ) {
    actionValue = {
      kind: 'mission_approval',
      missionId: val.missionId.trim(),
      nodeKey: val.nodeKey.trim(),
      planVersion: val.planVersion,
      decision: val.decision,
      ...(typeof val.title === 'string' ? { title: val.title } : {}),
    }
  } else if (
    val.kind === 'vault_request'
    && typeof val.requestId === 'string'
    && typeof val.ticketId === 'string'
    && (val.decision === 'approve' || val.decision === 'reject')
  ) {
    actionValue = {
      kind: 'vault_request',
      requestId: val.requestId.trim(),
      ticketId: val.ticketId.trim(),
      secretName: typeof val.secretName === 'string' ? val.secretName : '',
      decision: val.decision,
    }
  } else if (
    val.kind === 'ticket_op'
    && typeof val.ticketId === 'string'
    && (val.op === 'retry' || val.op === 'stop')
  ) {
    actionValue = {
      kind: 'ticket_op',
      ticketId: val.ticketId.trim(),
      op: val.op,
      ...(typeof val.title === 'string' ? { title: val.title } : {}),
    }
  }

  if (!actionValue) return undefined
  return {
    ...(eventId ? { eventId } : {}),
    operatorOpenId,
    ...(openMessageId ? { openMessageId } : {}),
    ...(openChatId ? { openChatId } : {}),
    actionValue,
  }
}
