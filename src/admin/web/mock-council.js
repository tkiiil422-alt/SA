/**
 * Mock routes for multi-role council sessions, task-book deliverables and the
 * council settings (F3 owns this file).
 *
 * mock.js calls install(registry) once at mock start. Register a route with:
 *
 *   registry.add('GET', '/api/councils/:id', ({ params, state }) => ({ id: params.id }))
 *
 * Paths may omit the leading `/api/`; `:name` captures one path segment.
 * A handler receives { path, method, params, body, url, state, json, ok, fail,
 * addEvent } and may return a plain object (sent as 200 JSON) or a Response.
 *
 * Scenario switch on the page URL: `&mockCouncil=fast|slow|fail|partial`.
 *   fast    — about 3 seconds end to end
 *   slow    — about 20 seconds, so the turns can be watched arriving
 *   fail    — every seat fails; the council ends as `failed`
 *   partial — the risk seat fails, everyone else still speaks
 *
 * The mock advances with the wall clock instead of timers, so every poll sees
 * a consistent picture and a reload does not restart the meeting.
 */
import { detail, clone, round4, todayKey } from './mock-data.js'
import { parseBrief } from './lib/brief.js'

const ROLES = [
  {
    id: 'analyst',
    name: '需求分析师',
    persona: '把一句话需求还原成可验收的目标；指出含糊之处；列出必须向用户确认的问题；不谈实现。',
    enabled: true,
  },
  {
    id: 'architect',
    name: '架构师',
    persona: '给出 1–2 个可行方案，说明取舍、改动范围、对现有代码的影响；有项目档案时引用具体目录或文件。',
    enabled: true,
  },
  {
    id: 'engineer',
    name: '实现工程师',
    persona: '把方案拆成可执行步骤，估顺序与工作量，指出最容易卡住的环节和需要的命令、依赖。',
    enabled: true,
  },
  {
    id: 'tester',
    name: '测试与验收',
    persona: '定义验收标准与验证命令，列边界情况与回归范围；说明怎么证明做完了。',
    enabled: true,
  },
  {
    id: 'risk',
    name: '风险与安全',
    persona: '找破坏性操作、密钥、权限、外网访问、数据丢失、成本失控；给出防护或必须让用户确认的点。',
    enabled: true,
  },
]

const DEFAULT_COUNCIL_SETTINGS = {
  enabled: true,
  defaultOn: false,
  rounds: 2,
  maxCharsPerTurn: 600,
  moderator: null,
  roles: ROLES,
}

const TASK_BRIEF = `# 给销售看板加上同比与一键导出

## 目标

业务同事打开销售看板时，能直接看到本月与去年同月的对比，并把当前筛选结果一键导出成表格。
做完的标准是：三个大区、按月和按周两种口径都能对上，导出的文件用 Excel 打开不乱码。

## 范围

- 看板顶部的筛选器增加「按自然月 / 按周」切换，默认按自然月。
- 汇总表和明细表都增加同比列；没有去年数据时显示「暂无同比」，不显示 0%。
- 增加「导出当前结果」按钮，导出内容与屏幕上的筛选一致。
- 补一份口径说明，写清楚同比是怎么算的。

| 区域 | 现有数据 | 需要补的 |
| --- | --- | --- |
| 华东 | 2025-01 起 | 无 |
| 华南 | 2025-03 起 | 2025-01、02 标成暂无 |
| 华北 | 2025-06 起 | 2025-01 至 05 标成暂无 |

## 不做

- 不改动原始销售库的表结构，也不在定时任务里回写历史数据。
- 不做移动端专门布局；现有响应式布局够用。
- 不做 PDF 导出。

## 方案

选 **方案 B：在查询层算同比，导出复用同一段查询**。

- 方案 A 是在 ETL 里预计算一张同比表。优点是查询快；缺点是历史回填一旦有错要重跑整条链路，改动面更大。
- 方案 B 只在 \`src/reports/sales.ts\` 里加一个 \`samePeriodLastYear()\`，看板和导出都调它。改动集中在一个文件和一个测试里，回滚也容易。
- 两套口径共用同一个日期窗口函数，避免看板按自然月、导出按周的情况。

\`\`\`bash
pnpm exec vitest run tests/sales-dashboard.spec.ts
pnpm exec tsc --noEmit
\`\`\`

## 步骤

1. 在 \`src/reports/sales.ts\` 增加同比窗口函数，先只接看板，不改导出。
2. 给汇总表和明细表加列，缺少去年数据时返回 \`null\`，前端显示「暂无同比」。
3. 抽出 \`buildSalesQuery(filters)\`，看板和导出都走它。
4. 导出用 CSV（UTF-8 BOM），文件名带日期范围和口径。
5. 补测试：跨年、缺月、空筛选、按周对齐四种情况。
6. 更新 \`docs/sales-metrics.md\` 的口径说明。

## 验收标准

- 看板在 390 px 和 1440 px 下都没有横向滚动。
- 华东、华南、华北三个区域的同比数字与手工抽查的 6 个样本一致。
- 导出的 CSV 在 Excel 中打开中文正常，列顺序与屏幕一致。
- 没有去年数据时显示「暂无同比」，而不是 0% 或空白。
- 新增测试全部通过，原有看板测试不退步。

## 风险与约束

- 同比查询会让汇总接口慢一些；先在现有索引下测，超过 800 ms 再加覆盖索引。
- 导出可能一次拉很多行；超过 5 万行时先提示「数据较多，正在生成」，不阻塞页面。
- CSV 公式注入：以 \`=\`、\`+\`、\`-\`、\`@\` 开头的单元格前加一个单引号。
- 销售数据含客户名，导出文件不要落到公共目录。

## 待你确认

- 同比按自然月还是按周对齐？默认：按自然月对齐，周维度在筛选器里可选。
- 导出的文件格式用 CSV 还是 XLSX？默认：CSV（UTF-8 BOM），方便直接用 Excel 打开。
- 历史数据只回填到 2025 年 1 月，行吗？默认：回填到 2025-01，更早的数据标成「暂无同比」。

## 会商分歧

- 架构师倾向在查询层算同比，实现工程师担心汇总接口变慢；主持人采纳「先测再决定是否加索引」。
- 测试与验收要求把「按周对齐」也写进验收，风险与安全提醒导出要防公式注入，两条都已列入上面。
`

const DECISION_BRIEF = `## 建议

把导出做成独立的 \`GET /reports/sales/export\`，不要复用看板页面的接口。
看板接口继续只返回当前页的数据，导出接口单独限流、单独超时。

## 理由

- 看板接口每 30 秒被轮询一次，导出是一次性大请求，两者混在一起会让首屏变慢。
- 单独接口可以只对导出做 60 秒超时和 5 万行上限，不影响看板。
- 出错时前端能明确区分「看板打不开」和「导出失败」，提示更准确。

## 备选

1. 复用看板接口，加一个 \`?export=1\` 参数。改动最小，但超时和分页会互相牵制。
2. 交给定时任务生成文件，再发下载链接。适合超大导出，但这一次的数据量不需要。

## 风险

- 新接口要沿用现有的登录校验，不能因为「只是下载」就放开。
- 导出文件名里含日期和筛选条件，注意不要带客户名。
- CSV 公式注入仍要在导出层处理，不能只靠前端。
`

function scenarioNow() {
  try {
    const params = new URLSearchParams(globalThis.location?.search ?? '')
    const value = params.get('mockCouncil')
    if (['fast', 'slow', 'fail', 'partial'].includes(String(value))) return String(value)
  } catch { /* no location (tests) */ }
  return 'normal'
}

function timingFor(scenario) {
  if (scenario === 'fast') return { stagger: 60, turn: 320, roundGap: 180, summary: 260 }
  if (scenario === 'slow') return { stagger: 900, turn: 2400, roundGap: 1100, summary: 1600 }
  return { stagger: 500, turn: 2000, roundGap: 800, summary: 1300 }
}

function turnText(roleId, n) {
  const first = {
    analyst: `**立场**：这个需求可以验收，但「同比」必须先定口径。

**要点**：

- 看板和导出必须用同一套筛选条件，否则数字会对不上。
- 华东有完整数据，华南从 3 月开始，华北从 6 月开始；缺月不能显示成 0%。
- 「暂无同比」要说人话，最好带一句为什么没有。

**需要确认**：按自然月还是按周对齐？导出要不要包含图表？`,
    architect: `**立场**：选方案 B，在查询层算同比，导出复用同一段查询。

**要点**：

- 现有 \`src/reports/sales.ts\` 已经有一个按日期聚合的函数，扩一个窗口参数即可。
- 方案 A 要把同比写进 ETL，回填出错就得重跑，改动面不值得。
- 导出单独开 \`export\` 路由，避免和看板 30 秒轮询抢同一个接口。

**需要确认**：现有汇总接口的 P95 是多少？如果超过 800 ms，我需要先加索引。`,
    engineer: `**立场**：可以按方案 B 拆，工作量大约半天到一天。

**要点**：

1. 先改 \`src/reports/sales.ts\`，加 \`samePeriodLastYear()\`，只动查询，不动页面。
2. 再抽 \`buildSalesQuery(filters)\`，看板和导出都调用它。
3. 导出接口用流式写 CSV，5 万行以内不需要临时文件。
4. 最容易卡住的是日期边界：2 月 29 日和跨年那一周要专门写测试。

**需要确认**：导出超过 5 万行时是截断还是提示？`,
    tester: `**立场**：验收要能证明「缺月不是 0%」，不能只看页面好不好看。

**要点**：

- 抽查 6 个样本：三个区域、按月和按周各一组，与手工 SQL 对齐。
- 边界情况：跨年、2 月、空筛选、只有一个月数据。
- 回归范围：现有看板的总计、区域筛选和排序不能变。
- 验证命令：\`pnpm exec vitest run tests/sales-dashboard.spec.ts\`。

**需要确认**：由谁提供手工抽查的基准数字？`,
    risk: `**立场**：导出是这次改动里最危险的一块，要先定防护。

**要点**：

- CSV 公式注入：以 \`=\`、\`+\`、\`-\`、\`@\` 开头的单元格要转义，否则 Excel 会执行公式。
- 导出文件含客户名，不能落到公共目录，也不能出现在未鉴权的静态路径下。
- 建议导出接口单独限流，同一用户同一时间只允许一个导出任务。
- 超过 5 万行时要有明确提示，避免一次拉爆内存。

**需要确认**：导出文件保留多久？是否要提供删除入口？`,
  }
  const second = {
    analyst: `我同意架构师的「同一段查询」，补一点：页面上的口径文案要写清楚是自然月还是周。

测试同学提的六个样本我认可；我会把「暂无同比」的原因写进文案，不让业务同事猜。

风险同学说的公式注入我不熟，但导出内容确实要再给风险同学过一眼。`,
    architect: `回应实现工程师：现有汇总接口本地测得 420 ms，慢查询主要在没有日期条件的时候；先不改索引，上线后看监控。

回应风险同学：导出单独路由、单独限流，我同意；文件名里不带客户名，只带日期范围和口径。

修正我第一轮的说法：方案 B 不是「只改一个文件」，前端筛选器也要跟着改，但改动仍然比 ETL 回填小。`,
    engineer: `同意方案 B，也同意先只接看板、再接导出，避免一次改太多。

补充一个卡点：按周对齐要决定「周一开始还是周日开始」。国内报表一般周一开始，我按周一做，测试时请覆盖跨年那一周。

导出超过 5 万行我建议提示后继续流式生成，不截断；截断更容易让人误以为数据完整。`,
    tester: `我坚持把「按周对齐」写进验收，尤其是跨年那一周。

另外补一条：导出后用 Excel 打开，中文不能乱码；这一条要人工看一眼，不能只跑自动化。

如果架构师能给出 420 ms 的基线，我会把它写进验收备注，超过 800 ms 算退步。`,
    risk: `同意导出单独路由。再补两条：

- 导出接口只允许登录用户访问，且同一时间只跑一个。
- 返回的 CSV 要加 \`nosniff\` 和附件头，避免浏览器把它当页面渲染。

公式注入必须在导出层做，不能只靠前端替换；前端可以被绕过。`,
  }
  const fallbackFirst = `**立场**：先把问题拆清楚，再决定怎么做。

**要点**：

- 目标是可验收的，不需要再扩大范围。
- 需要确认的地方我已经列在发言里。

**需要确认**：有没有遗漏的边界情况？`
  const fallbackSecond = `我同意前面几位的方向，补充一点：验收要能复现，不能只看一次截图。

如果时间不够，我建议先做最小可用的一版，再补边界情况。`
  const table = n === 1 ? first : second
  return table[roleId] ?? (n === 1 ? fallbackFirst : fallbackSecond)
}

function ensureData(state, addEvent) {
  if (state.__councilMockReady) return
  state.__councilMockReady = true
  state.councils = []
  state.settings.council = clone(DEFAULT_COUNCIL_SETTINGS)

  const iso = (minutesAgo) => new Date(Date.now() - minutesAgo * 60000).toISOString()

  // A brand-new ticket with a task book, a project and deliverables, so the
  // reworked ticket page can be exercised end to end.
  if (!state.tickets.some((ticket) => ticket.id === 'T-20261105-0950')) {
    const ticket = detail({
      id: 'T-20261105-0950',
      seed: 41,
      title: '给销售看板加上同比与一键导出',
      stage: { stage: 'working' },
      createdAt: iso(14),
      updatedAt: iso(1),
      costUsd: 0.0216,
      callCount: 4,
      question: '导出的文件要不要把图表一起打包？',
      attention: { kind: 'answer', at: iso(1), question: '导出的文件要不要把图表一起打包？' },
      reports: [{
        id: 'R-950',
        at: iso(1),
        state: 'waiting',
        summary: '同比查询已经接进看板，导出还差文件格式需要你确认。',
        question: '导出的文件要不要把图表一起打包？',
      }],
    }, null)
    ticket.project = { id: 'p_sales01', name: '2026 Q1 销售数据项目', preparing: false }
    ticket.council = { id: 'c_brief_done', status: 'done' }
    state.tickets.unshift(ticket)
    addEvent('ticket.created', ticket.id, 'info', `新任务：${ticket.title}`)
    addEvent('assignment.started', ticket.id, 'info', `AI 开始处理：${ticket.title}`)
  }

  const oldTicket = state.tickets.find((ticket) => ticket.id === 'T-20261105-0912')
  if (oldTicket) {
    oldTicket.project = { id: 'p_sales01', name: '2026 Q1 销售数据项目', preparing: false }
  }

  const now = Date.now()
  const register = (council) => {
    state.councils.push(council)
    return council
  }

  register({
    id: 'c_brief_run',
    mode: 'brief',
    topic: '给销售看板加上同比与一键导出：业务同事希望打开看板就能看到本月和去年同月的对比，并且能把当前筛选结果导成表格。请把口径、改动范围和验收标准都定下来，遇到需要我拍板的地方列出来。',
    projectId: 'p_sales01',
    roundsCount: 2,
    roles: ROLES,
    lazyStart: true,
    createdAt: new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString(),
  })

  register({
    id: 'c_brief_done',
    mode: 'brief',
    topic: '给销售看板加上同比与一键导出',
    projectId: 'p_sales01',
    ticketId: 'T-20261105-0950',
    roundsCount: 2,
    roles: ROLES,
    startedAt: new Date(now - 90000).toISOString(),
    createdAt: new Date(now - 100000).toISOString(),
    updatedAt: new Date(now - 1000).toISOString(),
    forceDone: true,
  })

  register({
    id: 'c_brief_fail',
    mode: 'brief',
    topic: '把旧日志迁移到新存储桶并核对条数',
    roundsCount: 2,
    roles: ROLES,
    startedAt: new Date(now - 60000).toISOString(),
    createdAt: new Date(now - 70000).toISOString(),
    updatedAt: new Date(now - 1000).toISOString(),
    forceFailed: true,
    error: '所有角色都没能发言：模型服务返回了鉴权错误（401），请检查密钥后再试。',
  })

  register({
    id: 'c_decision_done',
    mode: 'decision',
    topic: '导出功能要不要单独开一个接口？',
    ticketId: 'T-20261105-0950',
    roundsCount: 2,
    roles: ROLES,
    startedAt: new Date(now - 80000).toISOString(),
    createdAt: new Date(now - 90000).toISOString(),
    updatedAt: new Date(now - 1000).toISOString(),
    forceDone: true,
  })
}

export function install(registry) {
  const { state, addEvent } = registry
  ensureData(state, addEvent)

  const list = () => state.councils
  const find = (id) => list().find((council) => council.id === id)
  const scenarioFor = (council) => {
    if (council.forceFailed) return 'fail'
    return scenarioNow()
  }

  function ensureStarted(council) {
    if (!council.lazyStart) return
    if (council.startedAt) return
    council.startedAt = new Date().toISOString()
    council.createdAt = council.startedAt
    council.updatedAt = council.startedAt
  }

  function compute(council) {
    ensureStarted(council)
    const scenario = scenarioFor(council)
    const timing = timingFor(scenario)
    const started = Date.parse(council.startedAt ?? council.createdAt)
    let end = Date.now()
    if (council.cancelledAt) end = Math.min(end, Date.parse(council.cancelledAt))
    const elapsed = Math.max(0, end - started)

    const roles = (council.roles?.length ? council.roles : ROLES).filter((role) => role.enabled !== false)
    const totalRounds = Math.max(1, Math.min(3, Number(council.roundsCount ?? 2)))
    let cursor = 0
    const rounds = []
    const roundStarts = []

    for (let n = 1; n <= totalRounds; n += 1) {
      roundStarts.push(cursor)
      const turns = roles.map((role, index) => {
        const start = cursor + index * timing.stagger
        const duration = timing.turn + (index % 3) * 220
        const finish = start + duration
        const thisFails = scenario === 'fail' || (scenario === 'partial' && role.id === 'risk')
        let status = 'pending'
        if (elapsed >= finish) status = thisFails ? 'failed' : 'done'
        else if (elapsed >= start) status = 'running'
        return {
          roleId: role.id,
          name: role.name,
          status,
          text: status === 'done' ? turnText(role.id, n) : '',
          ms: status === 'done' ? duration : 0,
          costUsd: status === 'done' ? round4(0.0008 + ((n * 7 + index) % 5) * 0.0002) : 0,
        }
      })
      const roundEnd = cursor + (roles.length - 1) * timing.stagger + timing.turn + 440
      rounds.push({ n, turns })
      cursor = roundEnd + timing.roundGap
    }

    const summaryStart = cursor
    const summaryEnd = summaryStart + timing.summary
    const roundOneEnd = roundStarts.length ? roundStarts[0] + (roles.length - 1) * timing.stagger + timing.turn + 440 : 0

    let phase = 'queued'
    if (elapsed >= summaryEnd) phase = 'done'
    else if (elapsed >= summaryStart) phase = 'summary'
    else {
      for (let index = 0; index < roundStarts.length; index += 1) {
        const start = roundStarts[index] ?? 0
        const next = roundStarts[index + 1] ?? summaryStart
        if (elapsed >= start && elapsed < next) { phase = `round-${index + 1}`; break }
      }
      if (phase === 'queued' && elapsed >= 0 && roundStarts.length && elapsed >= (roundStarts[0] ?? 0)) phase = 'round-1'
      // Before the first turn starts we are still queued; the loop above sets round-1 as soon as its window opens.
      if (roundStarts.length && elapsed < (roundStarts[0] ?? 0)) phase = 'queued'
    }

    let status = 'running'
    if (council.cancelledAt) status = 'cancelled'
    else if (council.forceFailed || scenario === 'fail') {
      if (council.forceFailed || elapsed >= roundOneEnd) status = 'failed'
    } else if (elapsed >= summaryEnd) status = 'done'
    if (council.forceDone) { status = 'done'; phase = 'done' }

    const cost = round4(rounds.reduce((sum, round) => sum + round.turns.reduce((inner, turn) => inner + Number(turn.costUsd ?? 0), 0), 0)
      + (status === 'done' ? 0.0021 : 0))

    return {
      rounds,
      phase: status === 'done' ? 'done' : (status === 'failed' && phase === 'queued' ? 'done' : phase),
      status,
      elapsed,
      summaryStart,
      summaryEnd,
      costUsd: cost,
      scenario,
    }
  }

  function materialize(council) {
    const progress = compute(council)
    const modeBrief = council.mode === 'decision' ? DECISION_BRIEF : TASK_BRIEF
    let brief = ''
    if (progress.status === 'done' && council.mode === 'brief') {
      brief = modeBrief
      if (progress.scenario === 'partial') {
        brief += '\n\n> 说明：风险与安全这一位没能发言，安全部分建议你再过一遍。\n'
      }
    } else if (progress.status === 'done') {
      brief = modeBrief
    }
    let error = council.error
    if (progress.status === 'failed' && !error) {
      error = '所有角色都没能发言：模型服务暂时不可用，请稍后重试。'
    }
    return {
      id: council.id,
      mode: council.mode,
      status: progress.status,
      phase: progress.phase,
      topic: council.topic,
      ...(council.projectId ? { projectId: council.projectId } : {}),
      ...(council.ticketId ? { ticketId: council.ticketId } : {}),
      rounds: progress.rounds,
      ...(brief ? { brief } : {}),
      costUsd: progress.costUsd,
      ...(progress.status === 'failed' && error ? { error } : {}),
      createdAt: council.createdAt,
      updatedAt: new Date().toISOString(),
    }
  }

  function nextId() {
    state.__councilSeq = (state.__councilSeq ?? 0) + 1
    return `c_${Date.now().toString(36)}${state.__councilSeq.toString(36)}`
  }

  function nextTicketId() {
    state.__councilTicketSeq = (state.__councilTicketSeq ?? 0) + 1
    return `T-${todayKey(0).replaceAll('-', '')}-${String(960 + state.__councilTicketSeq).slice(-4)}`
  }

  /* ---------- councils ---------- */

  registry.add('GET', '/api/councils', ({ url }) => {
    const ticketId = url.searchParams.get('ticketId')
    const limit = Math.max(1, Number(url.searchParams.get('limit') ?? 20))
    const items = list()
      .filter((council) => !ticketId || council.ticketId === ticketId)
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
      .slice(0, limit)
      .map((council) => ({
        id: council.id,
        mode: council.mode,
        status: materialize(council).status,
        topic: council.topic,
        createdAt: council.createdAt,
        costUsd: materialize(council).costUsd,
      }))
    return { items }
  })

  registry.add('GET', '/api/councils/:id', ({ params, fail }) => {
    const council = find(params.id)
    if (!council) return fail(404, 'not_found', '这场会商不存在了。')
    return materialize(council)
  })

  registry.add('POST', '/api/councils', ({ body, fail }) => {
    const mode = body.mode === 'decision' ? 'decision' : 'brief'
    const text = String(body.text ?? '').trim()
    if (!text) return fail(400, 'validation', '话题不能为空。')
    if (text.length > 10000) return fail(400, 'validation', '话题太长，请精简到 10000 字以内。')
    const id = nextId()
    const now = new Date().toISOString()
    const council = {
      id,
      mode,
      topic: text,
      projectId: body.projectId ? String(body.projectId) : undefined,
      ticketId: body.ticketId ? String(body.ticketId) : undefined,
      roundsCount: Math.max(1, Math.min(3, Number(body.rounds ?? DEFAULT_COUNCIL_SETTINGS.rounds))),
      roles: Array.isArray(body.roles) && body.roles.length
        ? ROLES.filter((role) => body.roles.map(String).includes(role.id))
        : ROLES,
      createdAt: now,
      updatedAt: now,
      startedAt: now,
    }
    list().unshift(council)
    addEvent('council.started', council.ticketId, 'info', `开始${mode === 'decision' ? '决策' : '需求'}会商：${text.slice(0, 40)}`)
    return { id }
  })

  registry.add('POST', '/api/councils/:id/cancel', ({ params, fail }) => {
    const council = find(params.id)
    if (!council) return fail(404, 'not_found', '这场会商不存在了。')
    ensureStarted(council)
    if (!council.cancelledAt) council.cancelledAt = new Date().toISOString()
    council.updatedAt = council.cancelledAt
    addEvent('council.failed', council.ticketId, 'warn', `会商已取消：${council.topic.slice(0, 40)}`)
    return { ok: true }
  })

  registry.add('POST', '/api/councils/:id/commit', ({ params, body, fail }) => {
    const council = find(params.id)
    if (!council) return fail(404, 'not_found', '这场会商不存在了。')
    const progress = compute(council)
    if (council.mode !== 'brief') return fail(409, 'wrong_mode', '只有需求会商能开出任务。')
    if (progress.status !== 'done') return fail(409, 'not_done', '会商还没结束，等主持人汇总完再开工。')
    if (council.ticketId) return fail(409, 'already_committed', '这场会商已经开过工了。')
    const brief = String(body.brief ?? '').trim()
    if (!brief) return fail(400, 'validation', '任务书不能为空。')
    if (brief.length > 10000) return fail(400, 'validation', '任务书太长，请精简到 10000 字以内。')
    const parsed = parseBrief(brief)
    const title = parsed.title || '会商任务'
    const now = new Date().toISOString()
    const ticketId = nextTicketId()
    const ticket = detail({
      id: ticketId,
      seed: 60 + (state.__councilTicketSeq ?? 1),
      title: title.length > 46 ? `${title.slice(0, 46)}…` : title,
      stage: { stage: 'working', action: 'queued' },
      createdAt: now,
      updatedAt: now,
      costUsd: 0,
      callCount: 0,
      reports: [],
    }, null)
    if (council.projectId) {
      ticket.project = { id: council.projectId, name: '2026 Q1 销售数据项目', preparing: false }
    } else if (body.projectId) {
      ticket.project = { id: String(body.projectId), name: String(body.projectId), preparing: false }
    }
    if (body.model) {
      ticket.model = { ref: String(body.model), label: String(body.model), source: 'person' }
    }
    ticket.council = { id: council.id, status: 'done' }
    state.tickets.unshift(ticket)
    council.ticketId = ticketId
    council.updatedAt = now
    addEvent('ticket.created', ticketId, 'info', `会商后开工：${ticket.title}`)
    addEvent('council.done', ticketId, 'info', `会商完成并开工：${council.topic.slice(0, 40)}`)
    return { ok: true, ticketId, triggerId: `tg_${Date.now().toString(36)}` }
  })

  registry.add('DELETE', '/api/councils/:id', ({ params, fail }) => {
    const index = list().findIndex((council) => council.id === params.id)
    if (index < 0) return fail(404, 'not_found', '这场会商不存在了。')
    list().splice(index, 1)
    return { ok: true }
  })

  /* ---------- council settings ---------- */

  registry.add('GET', '/api/settings/council', () => clone(state.settings.council ?? DEFAULT_COUNCIL_SETTINGS))

  registry.add('PUT', '/api/settings/council', ({ body }) => {
    const before = state.settings.council ?? clone(DEFAULT_COUNCIL_SETTINGS)
    state.settings.council = {
      ...before,
      enabled: body.enabled === undefined ? before.enabled : body.enabled === true,
      defaultOn: body.defaultOn === undefined ? before.defaultOn : body.defaultOn === true,
      rounds: body.rounds === undefined ? before.rounds : Math.max(1, Math.min(3, Number(body.rounds))),
      maxCharsPerTurn: body.maxCharsPerTurn === undefined ? before.maxCharsPerTurn : Math.max(100, Number(body.maxCharsPerTurn)),
      moderator: body.moderator === undefined ? before.moderator : body.moderator,
      roles: Array.isArray(body.roles) && body.roles.length ? body.roles : before.roles,
    }
    addEvent('admin.settings', undefined, 'info', '修改了会商设置。')
    return { ok: true, settings: clone(state.settings.council) }
  })

  /* ---------- ticket extras ---------- */

  const DELIVERABLES = {
    'T-20261105-0950': [
      { path: 'output/销售看板改造说明.md', size: 18432, kind: 'md', minutesAgo: 2 },
      { path: 'output/README.md', size: 4218, kind: 'md', minutesAgo: 8 },
      { path: 'output/summary.csv', size: 91240, kind: 'csv', minutesAgo: 3 },
      { path: 'notes.txt', size: 1180, kind: 'txt', minutesAgo: 12 },
      { path: 'output/chart.png', size: 184320, kind: 'png', minutesAgo: 5 },
    ],
    'T-20261105-0912': [
      { path: 'output/Q1-销售汇总.md', size: 12044, kind: 'md', minutesAgo: 6 },
      { path: 'output/summary.csv', size: 51200, kind: 'csv', minutesAgo: 7 },
      { path: 'README.md', size: 2210, kind: 'md', minutesAgo: 40 },
      { path: 'reports/chart.png', size: 98432, kind: 'png', minutesAgo: 8 },
    ],
  }

  function deriveDeliverables(ticket) {
    const allowed = new Set(['md', 'txt', 'csv', 'json', 'html', 'pdf', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'avif'])
    return (ticket.files ?? [])
      .filter((file) => allowed.has(String(file.path).split('.').pop().toLowerCase()))
      .map((file, index) => ({
        path: file.path,
        size: file.size ?? 0,
        kind: String(file.path).split('.').pop().toLowerCase(),
        minutesAgo: 5 + index,
      }))
  }

  registry.add('GET', '/api/tickets/:id/deliverables', ({ params, fail }) => {
    const ticket = state.tickets.find((item) => item.id === params.id)
    if (!ticket) return fail(404, 'unknown_ticket', '找不到这张任务票。')
    const raw = DELIVERABLES[params.id] ?? deriveDeliverables(ticket)
    return {
      items: raw.map(({ minutesAgo, ...item }) => ({
        ...item,
        mtime: new Date(Date.now() - minutesAgo * 60000).toISOString(),
      })),
    }
  })

  registry.add('GET', '/api/tickets/:id/archive', ({ params, url, fail }) => {
    const ticket = state.tickets.find((item) => item.id === params.id)
    if (!ticket) return fail(404, 'unknown_ticket', '找不到这张任务票。')
    const which = url.searchParams.get('path') ?? ''
    if (which !== 'project' && which !== 'output') return fail(400, 'invalid_path', 'path 只能是 project 或 output。')
    const body = `mock archive of ${which} for ${params.id}\n`
    return new Response(body, {
      status: 200,
      headers: {
        'content-type': 'application/gzip',
        'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(`${params.id}-${which}.tar.gz`)}`,
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      },
    })
  })
}
