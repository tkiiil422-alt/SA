/**
 * The only place that knows how backend ticket stages become human wording.
 * Views never print stage / mandate / assignment values.
 */

export const STATUS_DEFS = {
  running: {
    key: 'running', label: '运行中', tone: 'run', icon: 'play',
    what: 'AI 正在处理这张任务票。',
    can: '你可以等它完成，也可以补充背景或要求它调整方向。',
  },
  waiting: {
    key: 'waiting', label: '等你回复', tone: 'ask', icon: 'help',
    what: 'AI 有一个问题需要你回答，回答之后它会继续。',
    can: '在下面的问题框里回复；如果问题不重要，也可以直接停止这张票。',
  },
  needs: {
    key: 'needs', label: '需要你处理', tone: 'attention', icon: 'alert',
    what: 'AI 卡住了，需要你做一个决定或补充信息。',
    can: '查看最近的报告，选择重试、补充说明，或者停止它。',
  },
  queued: {
    key: 'queued', label: '排队中', tone: 'queued', icon: 'hourglass',
    what: '这张票已经受理，正在等一个空闲的并发位置。',
    can: '前面的任务结束后会自动开始，通常不需要你操作。',
  },
  completed: {
    key: 'completed', label: '已完成', tone: 'done', icon: 'check',
    what: 'AI 已经完成并交付了结果。',
    can: '查看报告和产出文件；如果还想继续，可以补充说明。',
  },
  stopped: {
    key: 'stopped', label: '已停止', tone: 'stopped', icon: 'stop',
    what: '这张票已被手动停止，AI 不会再处理它。',
    can: '如果还想要结果，可以重试；不需要了就留在列表里备查。',
  },
  abandoned: {
    key: 'abandoned', label: '已放弃', tone: 'failed', icon: 'x',
    what: '这张票没有完成就被结束了。',
    can: '看看报告里的原因；需要的话可以重试，或重新发一张任务。',
  },
}

const ACTIONS = {
  answer: 'waiting',
  delivery: 'needs',
  review: 'needs',
  blocked: 'needs',
  failed: 'needs',
}

const OUTCOME_KEYS = {
  completed: 'completed', done: 'completed', success: 'completed', merged: 'completed',
  stopped: 'stopped', cancelled: 'stopped', canceled: 'stopped',
  abandoned: 'abandoned', abandon: 'abandoned', failed: 'abandoned', error: 'abandoned',
}

/** Look up a status definition by its key. */
export function statusOf(key) {
  return STATUS_DEFS[key] ?? STATUS_DEFS.running
}

/** The human question attached to a ticket, from any of the shapes the API may use. */
export function ticketQuestion(ticket) {
  if (!ticket) return ''
  const candidates = [
    ticket.question,
    ticket.attention?.question,
    ticket.attention?.text,
    ticket.attention?.summary,
  ]
  for (const value of candidates) if (typeof value === 'string' && value.trim()) return value
  return ''
}

/**
 * Derive one of the seven public statuses from an API summary or detail.
 * Accepts either the documented stage object or a plain string (defensive).
 */
export function ticketStatus(ticket) {
  if (!ticket) return STATUS_DEFS.running
  const ended = ticket.status === 'ended' || ticket.ended != null
  if (ended) {
    const outcome = String(ticket.outcome ?? ticket.ended?.outcome ?? '').toLowerCase()
    const byHuman = ticket.ended?.by === 'human'
    if (OUTCOME_KEYS[outcome]) return statusOf(OUTCOME_KEYS[outcome])
    return statusOf(byHuman ? 'stopped' : 'abandoned')
  }
  const stage = typeof ticket.stage === 'string' ? { stage: ticket.stage } : (ticket.stage ?? {})
  const question = ticketQuestion(ticket)
  const needs = ticket.needsPerson === true || ticket.attention != null || stage.stage === 'person'
  if (question) return STATUS_DEFS.waiting
  if (stage.stage === 'person') {
    return statusOf(ACTIONS[stage.action] ?? 'needs')
  }
  if (stage.stage === 'working') {
    return stage.action === 'queued' ? STATUS_DEFS.queued : STATUS_DEFS.running
  }
  if (stage.stage === 'idle') return STATUS_DEFS.running
  if (needs) return STATUS_DEFS.needs
  return STATUS_DEFS.running
}

/** Whether the ticket is open and waiting on a person, for showing retry. */
export function canRetry(ticket) {
  if (!ticket) return false
  if (ticket.status === 'ended' || ticket.ended != null) return false
  const status = ticketStatus(ticket)
  return status.key === 'waiting' || status.key === 'needs' || ticket.delivery != null
}

/** Whether this ticket should appear under "需要你处理". */
export function needsPerson(ticket) {
  return ticketStatus(ticket).key === 'waiting' || ticketStatus(ticket).key === 'needs'
}

/** Human label for a decision strength value. Unknown values stay hidden. */
export function strengthLabel(value) {
  const map = {
    strong: '明确匹配',
    normal: '一般匹配',
    medium: '一般匹配',
    weak: '较弱匹配',
    low: '较弱匹配',
  }
  return map[String(value ?? '').toLowerCase()] ?? ''
}

/** Human label for an event kind; unknown kinds never leak raw internals. */
export function eventKindLabel(kind) {
  const map = {
    'ticket.created': '新任务',
    'ticket.accepted': '受理任务',
    'ticket.stopped': '停止任务',
    'ticket.ended': '结束任务',
    'ticket.deleted': '删除任务',
    'assignment.started': 'AI 开始处理',
    'assignment.ended': 'AI 停止处理',
    'report.ready': 'AI 提交报告',
    'report.failed': 'AI 报告失败',
    'input.added': '新增消息',
    'budget.blocked': '预算拦截',
    'budget.warning': '预算提醒',
    'admin.settings': '修改配置',
    'admin.pause': '暂停接单',
    'admin.resume': '恢复接单',
    'admin.login': '登录后台',
    'admin.login_failed': '登录失败',
    'admin.password': '修改口令',
    'admin.cleanup': '清理工作区',
    'upstream.error': 'AI 服务出错',
    'assessor.decided': '任务分析',
    'assessor.failed': '分析失败',
    'system.start': '服务启动',
    'system.stop': '服务停止',
    'system.cleanup': '清理工作区',
    'system.backup': '自动备份',
    'feishu.received': '收到飞书消息',
    'feishu.continued': '并入任务',
    'feishu.rejected': '飞书请求被拒',
    'feishu.send_failed': '飞书发送失败',
    'feishu.ws': '飞书长连接',
    'github.pr': '开了 PR',
    'email.received': '收到邮件',
    'email.ignored': '忽略邮件',
    'email.sent': '发出邮件',
    'email.failed': '邮件失败',
    'secret.stored': 'AI 保存密钥',
    'secret.requested': '申请密钥',
    'secret.granted': '授权密钥',
    'secret.denied': '拒绝密钥',
    'secret.rotated': '更换密钥',
    'secret.deleted': '删除密钥',
    'secret.used': '使用密钥',
    'preview.registered': '发布预览',
  }
  return map[kind] ?? '系统事件'
}

/** Human label for a level key. */
export function levelLabel(level) {
  return { info: '信息', warn: '注意', error: '出错' }[level] ?? '信息'
}

/** Human label for an input kind. */
export function inputKindLabel(kind) {
  return {
    trigger: '外部指令',
    note: '补充说明',
    message: '消息',
    human: '你的消息',
    reply: '你的回复',
  }[kind] ?? '消息'
}

/** Human label for acceptMode, used in settings and the overview. */
export function acceptModeLabel(mode) {
  return {
    auto: '自动接单',
    observe: '只记录，不接单',
    off: '不接新任务',
  }[mode] ?? '自动接单'
}
