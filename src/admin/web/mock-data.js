/**
 * Demo data for mock mode. Shapes are documented in mock.js; this file only
 * builds the fake world (tickets, calls, usage, decisions, settings).
 */

import { ticketStatus } from './lib/status.js'

export const DAY_MS = 86400000

export function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value))
}

function rnd(seed) {
  const x = Math.sin(seed * 127.1 + 311.7) * 43758.5453
  return x - Math.floor(x)
}

export function round4(value) {
  return Math.round(Number(value) * 10000) / 10000
}

export function todayKey(daysAgo = 0) {
  const date = new Date(Date.now() - daysAgo * DAY_MS)
  const pad = (n) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

function workspaceFor(title) {
  const readme = [
    `# ${title}`,
    '',
    '这是 AI 在任务工作区里留下的产出。',
    '',
    '- 结果文件在 `output/` 下',
    '- 原始数据在 `data/` 下',
    '- 中间脚本在 `src/` 下',
  ].join('\n')
  const files = {
    'README.md': { text: readme },
    'notes.md': { text: `## 过程记录\n\n1. 读取输入\n2. 分析并生成结果\n3. 自检通过\n` },
    'src/index.js': { text: `export function run(input) {\n  return input.map((row) => ({ ...row, checked: true }))\n}\n` },
    'src/util.js': { text: `export const round = (n, digits = 2) => Number(n.toFixed(digits))\n` },
    'data/source.csv': { text: 'id,customer,amount\n1,示例客户,299.00\n2,另一个客户,1280.00\n' },
    'output/summary.md': { text: `# 汇总\n\n共处理 2 条记录。\n\n- 合计：1579.00\n- 平均：789.50\n` },
    'output/report.png': { binary: true, size: 184320 },
  }
  const entries = Object.entries(files).map(([path, file]) => ({
    path,
    text: file.text,
    binary: Boolean(file.binary),
    size: file.binary ? file.size : new TextEncoder().encode(file.text ?? '').length,
  }))
  return {
    files: entries,
    fileCount: entries.length,
  }
}

function makeCalls(seed, count, totalUsd) {
  if (!count) return []
  const per = totalUsd / count
  return Array.from({ length: count }, (_, index) => {
    const hit = Math.round(400 + rnd(seed + index) * 2600)
    const miss = Math.round(120 + rnd(seed + index * 3) * 900)
    const completion = Math.round(80 + rnd(seed + index * 7) * 700)
    return {
      at: new Date(Date.now() - (index + 1) * 7 * 60000).toISOString(),
      model: index % 5 === 4 ? 'deepseek-v4.1' : 'deepseek-v4.1-flash',
      status: index === count - 1 && seed % 4 === 0 ? 500 : 200,
      promptHit: hit,
      promptMiss: miss,
      completion,
      costUsd: round4(per),
      latencyMs: Math.round(280 + rnd(seed + index * 11) * 1800),
    }
  })
}

function makeUsage(calls, totalUsd) {
  const hit = calls.reduce((sum, call) => sum + call.promptHit, 0)
  const miss = calls.reduce((sum, call) => sum + call.promptMiss, 0)
  const out = calls.reduce((sum, call) => sum + call.completion, 0)
  return {
    totalUsd: round4(totalUsd),
    calls: calls.length,
    hit,
    miss,
    out,
    hitRate: hit + miss ? hit / (hit + miss) : 0,
  }
}

export function detail(cfg, tickets) {
  const calls = makeCalls(cfg.seed ?? 1, cfg.callCount ?? 6, cfg.costUsd)
  const usage = makeUsage(calls, cfg.costUsd)
  const workspace = workspaceFor(cfg.title)
  const t = {
    id: cfg.id,
    title: cfg.title,
    status: cfg.status ?? 'open',
    stage: cfg.stage ?? { stage: 'working' },
    stageLabel: cfg.stageLabel ?? '',
    needsPerson: Boolean(cfg.needsPerson),
    question: cfg.question,
    outcome: cfg.outcome,
    createdAt: cfg.createdAt,
    updatedAt: cfg.updatedAt,
    costUsd: round4(cfg.costUsd),
    mandate: { strength: 'strong', actor: 'cli', scope: 'ticket', policyVersion: 3 },
    assignments: cfg.assignments ?? [{
      id: `A-${cfg.id}`,
      state: cfg.status === 'ended' ? 'ended' : 'running',
      createdAt: cfg.createdAt,
      startedAt: cfg.createdAt,
      endedAt: cfg.ended?.at,
      endedReason: cfg.ended?.reason,
      report: cfg.reports?.at(-1),
    }],
    reports: cfg.reports ?? [],
    secrets: cfg.secrets ?? [],
    previews: cfg.previews ?? [],
    links: cfg.links ?? [],
    attention: cfg.attention,
    delivery: cfg.delivery,
    inputs: cfg.inputs ?? [{ id: `I-${cfg.id}`, kind: 'trigger', at: cfg.createdAt, text: cfg.title }],
    messages: cfg.messages ?? [],
    usage,
    calls,
    events: [],
    workspace: {
      path: `/var/lib/superagent/workspaces/${cfg.id}`,
      exists: cfg.status !== 'open' || cfg.stage?.action !== 'queued',
      fileCount: cfg.status === 'open' && cfg.stage?.action === 'queued' ? 0 : workspace.fileCount,
    },
    files: cfg.status === 'open' && cfg.stage?.action === 'queued' ? [] : workspace.files,
    cleaned: false,
    ended: cfg.ended,
    workspaceMb: Math.round((8 + rnd((cfg.seed ?? 1) * 3) * 90) * 10) / 10,
    piConfigMb: Math.round((4 + rnd((cfg.seed ?? 1) * 5) * 22) * 10) / 10,
  }
  if (cfg.status === 'ended' && !t.ended) {
    t.ended = { at: cfg.updatedAt, by: 'system', outcome: t.outcome }
  }
  return t
}

function baseTickets() {
  const iso = (minutesAgo) => new Date(Date.now() - minutesAgo * 60000).toISOString()
  return [
    detail({
      id: 'T-20261105-0912', seed: 2, title: '整理 2026 年 Q1 销售数据，生成汇总表和三条结论',
      stage: { stage: 'working' }, createdAt: iso(52), updatedAt: iso(2), costUsd: 0.0842, callCount: 9,
      reports: [
        { id: 'R-1a', at: iso(31), state: 'waiting', summary: '先把三个区的数据分开清洗；华东区有两天的记录缺失，正在用同口径补齐。' },
        { id: 'R-1b', at: iso(19), state: 'working', summary: '缺失数据已补齐，汇总表生成到一半；同比列会同时给出按月和按周两种口径。' },
        { id: 'R-1', at: iso(8), state: 'waiting', summary: '数据已清洗完，正在生成汇总表和结论。' },
      ],
      messages: [{ id: 'M-1', at: iso(50), author: '你', text: '重点看华东区，另外把同比也加上。' }],
      secrets: ['OPENAI_API_KEY', 'WEATHER_API_KEY'],
      previews: [
        { port: 19000, title: '销售数据看板', path: 'p/7f3a9c21d4e8/', active: true },
        { port: 19001, title: '上一版对比页', path: 'p/2b8e6d40a9c1/', active: false },
      ],
    }, null),
    detail({
      id: 'T-20261105-0911', seed: 3, title: '把官网英文版价格页改成人民币显示',
      stage: { stage: 'person', action: 'answer' }, needsPerson: true,
      question: '价格要显示成「¥299」还是「299 元」？另外含不含税？',
      attention: { kind: 'answer', at: iso(6), question: '价格要显示成「¥299」还是「299 元」？另外含不含税？' },
      createdAt: iso(40), updatedAt: iso(6), costUsd: 0.0312, callCount: 5,
      reports: [{ id: 'R-2', at: iso(6), state: 'waiting', summary: '价格页结构已改好，显示格式需要你确认。', question: '价格要显示成「¥299」还是「299 元」？另外含不含税？' }],
      messages: [{ id: 'M-2', at: iso(6), author: 'AI', text: '价格页结构已改好，显示格式需要你确认。' }],
    }, null),
    detail({
      id: 'T-20261105-0910', seed: 4, title: '修复登录接口偶发 500 错误',
      stage: { stage: 'person', action: 'failed' }, needsPerson: true,
      createdAt: iso(120), updatedAt: iso(22), costUsd: 0.2104, callCount: 14,
      links: [{
        kind: 'pr',
        url: 'https://github.com/octocat/Hello-World/pull/42',
        title: '修复登录接口偶发 500 错误（草稿 PR）',
      }],
      reports: [{ id: 'R-3', at: iso(22), state: 'failed', summary: '尝试了两种修复方案，都没能稳定复现。需要你提供出错时的请求日志。' }],
    }, null),
    detail({
      id: 'T-20261105-0909', seed: 5, title: '给客户发一封项目周报邮件',
      status: 'ended', outcome: 'completed', stage: { stage: 'ended' },
      createdAt: iso(180), updatedAt: iso(25), costUsd: 0.136, callCount: 8,
      ended: { at: iso(25), by: 'executor', outcome: 'completed' },
      reports: [{ id: 'R-4', at: iso(28), state: 'ready', summary: '周报已发送给 3 位客户，附件包含本周进度表。' }],
    }, null),
    detail({
      id: 'T-20261026-0420', seed: 6, title: '重写整个网站的用户系统',
      status: 'ended', outcome: 'stopped', stage: { stage: 'ended' },
      createdAt: new Date(Date.now() - 12 * DAY_MS).toISOString(),
      updatedAt: new Date(Date.now() - 10 * DAY_MS).toISOString(),
      costUsd: 0.5021, callCount: 18,
      ended: { at: new Date(Date.now() - 10 * DAY_MS).toISOString(), by: 'human', outcome: 'stopped', reason: '方向不对，先停一下' },
      reports: [{ id: 'R-5', at: new Date(Date.now() - 10 * DAY_MS).toISOString(), state: 'waiting', summary: '完成了用户表结构设计，正在改注册流程。' }],
    }, null),
    detail({
      id: 'T-20261016-0155', seed: 7, title: '把旧日志迁移到新存储桶',
      status: 'ended', outcome: 'abandoned', stage: { stage: 'ended' },
      createdAt: new Date(Date.now() - 25 * DAY_MS).toISOString(),
      updatedAt: new Date(Date.now() - 20 * DAY_MS).toISOString(),
      costUsd: 0.041, callCount: 3,
      ended: { at: new Date(Date.now() - 20 * DAY_MS).toISOString(), by: 'system', outcome: 'abandoned' },
      reports: [{ id: 'R-6', at: new Date(Date.now() - 20 * DAY_MS).toISOString(), state: 'blocked', summary: '目标存储桶没有访问权限，缺 SA_KEY。' }],
    }, null),
    detail({
      id: 'T-20261105-0913', seed: 8, title: '执行数据库迁移脚本并验证结果',
      stage: { stage: 'working', action: 'queued' }, createdAt: iso(4), updatedAt: iso(4), costUsd: 0, callCount: 0,
    }, null),
    detail({
      id: 'T-20261105-0908', seed: 9, title: '批量抓取竞品价格并生成对比报告',
      stage: { stage: 'person', action: 'answer' }, needsPerson: true,
      question: '这张票已用 $0.50，上限 $0.50。要提高上限后重试吗？',
      attention: { kind: 'answer', at: iso(35), question: '这张票已用 $0.50，上限 $0.50。要提高上限后重试吗？' },
      createdAt: iso(200), updatedAt: iso(35), costUsd: 0.5021, callCount: 22,
      reports: [{ id: 'R-8', at: iso(35), state: 'blocked', summary: '已达到预算上限，暂停执行。', question: '这张票已用 $0.50，上限 $0.50。要提高上限后重试吗？' }],
    }, null),
    detail({
      id: 'T-20261105-0914', seed: 10, title: '为产品文档生成英文翻译草稿',
      stage: { stage: 'working' }, createdAt: iso(18), updatedAt: iso(1), costUsd: 0.018, callCount: 4,
      reports: [{ id: 'R-9', at: iso(12), state: 'waiting', summary: '已翻译前两章，继续处理第三章。' }],
      secrets: ['DATABASE_URL'],
    }, null),
  ]
}

function baseSecrets() {
  const minutesAgo = (minutes) => new Date(Date.now() - minutes * 60000).toISOString()
  const daysAgo = (days) => new Date(Date.now() - days * DAY_MS).toISOString()
  return [
    {
      name: 'OPENAI_API_KEY',
      description: '翻译和摘要任务用的 OpenAI 密钥',
      origin: 'operator',
      value: 'sk-demo-openai-5f2c9a',
      createdAt: daysAgo(18),
      rotatedAt: daysAgo(4),
      lastUsedAt: minutesAgo(35),
    },
    {
      name: 'DATABASE_URL',
      description: '测试库连接串，只给迁移任务用',
      origin: 'operator',
      value: 'postgres://demo:demo@127.0.0.1:5432/app',
      createdAt: daysAgo(32),
      lastUsedAt: minutesAgo(180),
    },
    {
      name: 'WEATHER_API_KEY',
      description: '天气接口的 key，AI 自己存进来的',
      origin: 'ai',
      value: 'w-demo-8a1b2c3d',
      createdAt: minutesAgo(140),
      lastUsedAt: minutesAgo(95),
    },
  ]
}

function baseSecretRequests() {
  const minutesAgo = (minutes) => new Date(Date.now() - minutes * 60000).toISOString()
  return [
    {
      id: 'SR-2001',
      ticketId: 'T-20261105-0912',
      name: 'DATABASE_URL',
      why: '汇总表要写回测试库，想直接连。',
      at: minutesAgo(5),
      status: 'pending',
    },
    {
      id: 'SR-2002',
      ticketId: 'T-20261105-0914',
      name: 'OPENAI_API_KEY',
      why: '第三章术语多，想换成 OpenAI 再校一遍。',
      at: minutesAgo(16),
      status: 'pending',
    },
    {
      id: 'SR-2003',
      ticketId: 'T-20261105-0909',
      name: 'SMTP_PASSWORD',
      why: '发周报需要邮箱密码。',
      at: minutesAgo(210),
      status: 'denied',
    },
    {
      id: 'SR-2004',
      ticketId: 'T-20261105-0912',
      name: 'WEATHER_API_KEY',
      why: '补充天气字段时要调一次天气接口。',
      at: minutesAgo(320),
      status: 'granted',
    },
  ]
}

function baseDecisions() {
  const iso = (minutesAgo) => new Date(Date.now() - minutesAgo * 60000).toISOString()
  return [
    { id: 'D-101', at: iso(4), kind: 'accept', kindLabel: '接成任务', threadKey: 'cli:local', ticketId: 'T-20261105-0913', triggerText: '执行数据库迁移脚本并验证结果', reasonText: ['你直接在命令行里下了指令', '内容包含明确的可执行动作'], strength: 'strong' },
    { id: 'D-102', at: iso(6), kind: 'ask-person', kindLabel: '转给你确认', threadKey: 'mail:customer-42', ticketId: 'T-20261105-0911', triggerText: '价格页改成人民币', reasonText: ['涉及面向客户的价格展示', '显示格式有多种合理选择'], strength: 'normal' },
    { id: 'D-103', at: iso(22), kind: 'hand-off', kindLabel: '转给你处理', threadKey: 'ci:web', ticketId: 'T-20261105-0910', triggerText: '登录接口偶发 500', reasonText: ['连续两次修复都失败了', '缺少复现所需的请求日志'], strength: 'strong' },
    { id: 'D-104', at: iso(35), kind: 'budget', kindLabel: '预算拦截', threadKey: 'cli:local', ticketId: 'T-20261105-0908', triggerText: '批量抓取竞品价格', reasonText: ['这张票的花费达到单票上限', '需要你决定是否提高上限'], strength: 'weak' },
    { id: 'D-105', at: iso(52), kind: 'accept', kindLabel: '接成任务', threadKey: 'cli:local', ticketId: 'T-20261105-0912', triggerText: '整理 Q1 销售数据', reasonText: ['任务目标清晰', '数据源已经在工作区里'], strength: 'strong' },
    { id: 'D-106', at: iso(180), kind: 'accept', kindLabel: '接成任务', threadKey: 'mail:customer-7', ticketId: 'T-20261105-0909', triggerText: '发项目周报', reasonText: ['发件人是已登记的客户', '内容是常规的进度汇报'], strength: 'normal' },
    { id: 'D-107', at: iso(1440), kind: 'reject', kindLabel: '没有接', threadKey: 'mail:spam', triggerText: '限时优惠，点此领取', reasonText: ['发件人不在允许名单里', '内容与工作无关'], strength: 'strong' },
  ]
}

function backupStamp(date) {
  const pad = (n) => String(n).padStart(2, '0')
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-` +
    `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
}

function baseBackups() {
  const mb = 1024 * 1024
  return [
    { hoursAgo: 6, bytes: Math.round(27.4 * mb) },
    { hoursAgo: 30, bytes: Math.round(26.9 * mb) },
    { hoursAgo: 54, bytes: Math.round(27.1 * mb) },
    { hoursAgo: 78, bytes: Math.round(26.3 * mb) },
  ].map(({ hoursAgo, bytes }) => {
    const at = new Date(Date.now() - hoursAgo * 3600000)
    return { name: `state-${backupStamp(at)}.tgz`, at: at.toISOString(), bytes }
  })
}

function baseOrphans() {
  const mb = 1024 * 1024
  return [
    {
      id: 'orphan-ws-20260918-0311',
      kind: 'workspace',
      path: '/var/lib/superagent/workspaces/T-20260918-0311',
      bytes: Math.round(384.6 * mb),
    },
    {
      id: 'orphan-ws-20260924-0440',
      kind: 'workspace',
      path: '/var/lib/superagent/workspaces/T-20260924-0440',
      bytes: Math.round(96.2 * mb),
    },
    {
      id: 'orphan-pi-20260924-0440',
      kind: 'pi-config',
      path: '/var/lib/superagent/pi-config/T-20260924-0440',
      bytes: Math.round(12.4 * mb),
    },
  ]
}

function makeUsageDays() {
  const days = []
  for (let index = 0; index < 30; index += 1) {
    const r = rnd(index + 1)
    const r2 = rnd(index * 2 + 7)
    const calls = Math.round(4 + r * 18 + (index % 7 === 0 ? 6 : 0))
    const hit = Math.round(calls * (420 + r2 * 900))
    const miss = Math.round(calls * (90 + r * 260))
    const out = Math.round(calls * (120 + r2 * 400))
    const usd = round4(0.004 + calls * 0.0032 + miss * 0.0000016 + out * 0.000004)
    days.push({
      day: todayKey(index),
      usd,
      calls,
      hit,
      miss,
      out,
      hitRate: hit + miss ? hit / (hit + miss) : 0,
    })
  }
  return days
}

export function createState(params) {
  const empty = params.get('empty') === '1'
  const tickets = empty ? [] : baseTickets()
  const decisions = empty ? [] : baseDecisions()
  const state = {
    authenticated: params.get('login') !== '1',
    password: 'demo',
    usingGeneratedPassword: !empty,
    loginFails: 0,
    settings: {
      policy: {
        paused: false,
        acceptMode: 'auto',
        evalTimeoutSeconds: 60,
        rules: [
          { id: 'r-mail', name: '只接客户邮件', enabled: true, instruction: '发件人必须是已登记的客户；内部同事的闲聊不要接。' },
          { id: 'r-urgent', name: '紧急问题优先', enabled: true, instruction: '标题带「紧急」或「线上故障」的消息立刻开票。' },
          { id: 'r-prod', name: '改动生产前先问', enabled: false, instruction: '涉及生产数据库或部署的改动，先转给我确认。' },
        ],
        allowedOperators: [
          { id: 'cli-local', name: '我的笔记本（命令行）' },
          { id: 'cli-phone', name: '手机上的快捷指令' },
        ],
        feishuOperators: [
          { id: 'ou_demo_zhangsan', name: '张三' },
        ],
      },
      executor: { maxWorkers: 2, cpus: '2', memory: '6g', image: 'localhost/superagent-pi:1.5.0' },
      feishu: {
        enabled: false,
        mode: 'webhook',
        appId: '',
        appSecretSet: false,
        verificationTokenSet: false,
        encryptKeySet: false,
        apiBase: 'https://open.feishu.cn',
        groupMode: 'mention',
      },
      models: {
        providers: [
          {
            id: 'opencode-go',
            name: 'OpenCode Go',
            api: 'openai-completions',
            baseUrl: 'https://opencode.ai/inference/go/openai/v1',
            apiKey: 'sk-demo-1234567890abcd9f3a',
            sessionHeader: 'x-opencode-session',
            enabled: true,
            models: [
              {
                id: 'deepseek-v4.1-flash',
                label: 'DeepSeek V4.1 Flash',
                description: '便宜又快，适合整理资料、摘要和简单改写。',
                reasoning: true,
                vision: true,
                contextWindow: 1000000,
                maxTokens: 384000,
                autoPick: true,
                price: { input: 0.3, cacheRead: 0.006, output: 1.2 },
                thinkingLevelMap: { minimal: null, low: 'low', medium: null, high: 'high', xhigh: null, max: 'max' },
              },
              {
                id: 'deepseek-v4.1',
                label: 'DeepSeek V4.1',
                description: '更强，适合复杂代码改动和长推理，花费更高。',
                reasoning: true,
                vision: false,
                contextWindow: 1000000,
                maxTokens: 384000,
                autoPick: true,
                price: { input: 1.2, cacheRead: 0.02, output: 4.8 },
              },
            ],
          },
          {
            id: 'anthropic',
            name: 'Anthropic',
            api: 'anthropic-messages',
            baseUrl: 'https://api.anthropic.com',
            apiKey: '',
            sessionHeader: '',
            enabled: false,
            models: [
              { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5', description: '写作和复杂推理很稳，价格中等。', reasoning: true, vision: true, contextWindow: 200000, maxTokens: 64000, autoPick: true, price: { input: 3, cacheRead: 0.3, output: 15 } },
              { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5', description: '快且便宜，适合分析和短任务。', reasoning: false, vision: true, contextWindow: 200000, maxTokens: 32000, autoPick: true, price: { input: 0.8, cacheRead: 0.08, output: 4 } },
            ],
          },
        ],
        routing: {
          worker: { provider: 'opencode-go', model: 'deepseek-v4.1-flash' },
          assessor: { enabled: true, provider: 'opencode-go', model: 'deepseek-v4.1-flash', timeoutSec: 30 },
          autoSelect: false,
        },
      },
      budget: { enabled: true, perTicketUsd: 0.5, dailyUsd: 5 },
      github: {
        enabled: false,
        repos: ['octocat/Hello-World', 'octocat/Spoon-Knife'],
        defaultBase: 'main',
        apiBase: 'https://api.github.com',
        tokenSet: false,
      },
      email: {
        enabled: false,
        address: '',
        displayName: '超级智能体',
        allowedSenders: [],
        pollSeconds: 60,
        maxAttachmentMb: 20,
        passwordSet: false,
      },
      preview: { enabled: true, portStart: 19000, portEnd: 19199, perTicket: 2, publicBase: '' },
    },
    tickets,
    secrets: empty ? [] : baseSecrets(),
    secretRequests: empty ? [] : baseSecretRequests(),
    decisions,
    backupsDir: '/var/lib/superagent/backups',
    backups: empty ? [] : baseBackups(),
    orphans: empty ? [] : baseOrphans(),
    usageDays: empty ? Array.from({ length: 30 }, (_, index) => ({
      day: todayKey(index), usd: 0, calls: 0, hit: 0, miss: 0, out: 0, hitRate: 0,
    })) : makeUsageDays(),
    events: [],
    eventSeq: 0,
    startedAt: new Date(Date.now() - 196 * 60000).toISOString(),
  }

  // Mock-only convenience: the feishu settings survive a reload in the same tab,
  // so saving the receive mode behaves like it would against a real backend.
  try {
    const saved = globalThis.sessionStorage?.getItem('sa:mock:feishu')
    if (saved) state.settings.feishu = { ...state.settings.feishu, ...JSON.parse(saved) }
  } catch {
    // Session storage can be unavailable (private mode); start from defaults.
  }

  const pushEvent = (at, kind, ticketId, level, text) => {
    state.eventSeq += 1
    state.events.push({ id: state.eventSeq, at, kind, ticketId, level, text })
  }

  pushEvent(state.startedAt, 'system.start', undefined, 'info', '守护进程启动，开始接收消息。')
  pushEvent(new Date(Date.now() - 180 * 60000).toISOString(), 'admin.login', undefined, 'info', '管理员登录了后台。')
  if (!empty) {
    for (const ticket of tickets) {
      pushEvent(ticket.createdAt, 'ticket.created', ticket.id, 'info', `新任务：${ticket.title}`)
      if (ticket.status === 'ended') {
        pushEvent(ticket.ended.at, 'ticket.ended', ticket.id, ticket.outcome === 'completed' ? 'info' : 'warn',
          ticket.outcome === 'stopped' ? `任务已停止：${ticket.title}` : `任务结束（${ticket.outcome === 'completed' ? '已完成' : '未完成'}）：${ticket.title}`)
      } else if (ticket.needsPerson) {
        pushEvent(ticket.updatedAt, ticket.question?.includes('预算') ? 'budget.blocked' : 'report.failed', ticket.id, 'warn',
          ticket.question?.includes('预算') ? `预算拦截：${ticket.title}` : `需要你处理：${ticket.title}`)
      } else if (ticket.stage?.action === 'queued') {
        pushEvent(ticket.createdAt, 'ticket.accepted', ticket.id, 'info', `任务已受理，等待空闲位置：${ticket.title}`)
      } else {
        pushEvent(ticket.createdAt, 'assignment.started', ticket.id, 'info', `AI 开始处理：${ticket.title}`)
      }
    }
    pushEvent(new Date(Date.now() - 95 * 60000).toISOString(), 'budget.warning', 'T-20261105-0908', 'warn', '任务「批量抓取竞品价格并生成对比报告」达到单票预算上限 $0.50。')
    pushEvent(new Date(Date.now() - 70 * 60000).toISOString(), 'admin.settings', undefined, 'info', '修改了执行配置：并发任务数 1 → 2。')
  }
  state.events.sort((a, b) => b.id - a.id)
  return state
}

