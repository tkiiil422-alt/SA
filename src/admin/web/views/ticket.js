/** 任务详情: the question, the task book, the output, the project, and what happened. */
import { get, post, put, del, invalidateOverview } from '../lib/api.js'
import { bus } from '../lib/bus.js'
import * as keep from '../lib/keep.js'
import { esc, money4, ago, stateWord, icons } from '../lib/view.js'
import { renderMarkdown } from '../lib/markdown.js'
import { absTime, bytes } from '../lib/format.js'
import {
  modeWord, statusWord, roundProgress, roundsHtml, decisionHtml, decisionParts,
  briefHtml, copyText,
} from '../lib/council-view.js'

const SOURCE = { person: '你指定', auto: '自动挑选', default: '默认' }
const READABLE = new Set(['md', 'txt', 'csv', 'json'])

function tsection(key, title, body, { count = '', note = '', open = true, id = '' } = {}) {
  return `<details class="disclose cv-tsec" data-keep="ticket.${key}"${id ? ` id="${id}"` : ''}${open ? ' open' : ''}>
    <summary>
      <span class="cv-tsec__title">${esc(title)}</span>
      ${count ? `<span class="section__count">${esc(count)}</span>` : ''}
      ${note ? `<span class="section__note">${esc(note)}</span>` : ''}
    </summary>
    <div class="cv-tsec__body">${body}</div>
  </details>`
}

function modelLine(model) {
  if (!model?.label) return ''
  const tag = SOURCE[model.source] ?? '默认'
  const reason = model.source === 'auto' && model.reason ? `（${model.reason}）` : ''
  const provider = model.providerName ? `${model.providerName} · ` : ''
  return `<p class="model-line">执行模型 ${esc(provider)}${esc(model.label)}<span class="tag">${tag}</span>${esc(reason)}</p>`
}

export function mount(ctx) {
  const id = ctx.params.id
  const root = document.createElement('div')
  root.className = ctx.split ? 'page is-split' : 'page'
  const state = {
    filePath: '', fileData: null, filesOpen: false, filesHtml: '', busy: false,
    current: null, deleteOpen: false, deleteWorkspace: true, deleteText: '',
    secretsOpen: false, secretChoices: null, secretChoicesError: '',
    secretSelected: new Set(), secretsBusy: false,
    council: null,
    councilError: '',
    deliverables: [],
    history: [],
    live: null,
    liveId: '',
    replyDraft: '',
    dialogOpen: false,
    // 执行过程: the worker's recent steps, merged by entry id; `actFollow` keeps the log pinned to its newest line.
    activity: [],
    activityLast: 0,
    activityAt: '',
    actFollow: true,
  }
  let alive = true
  let liveTimer = null
  let actTimer = null

  try { state.liveId = sessionStorage.getItem(`sa-ticket-council-${id}`) ?? '' } catch { /* private mode */ }
  try {
    const saved = sessionStorage.getItem(`sa-ticket-reply-${id}`) ?? ''
    if (saved) {
      state.replyDraft = saved
      sessionStorage.removeItem(`sa-ticket-reply-${id}`)
    }
  } catch { /* private mode */ }

  const api = (suffix) => `api/tickets/${encodeURIComponent(id)}${suffix}`

  async function render() {
    if (!alive) return
    let data
    try {
      data = await get(api(''))
    } catch (error) {
      if (error?.status === 401) return
      root.innerHTML = `<div class="banner"><span>这张任务没有读出来：${esc(error?.message || '请求失败')}</span>
        <a class="btn btn--quiet" href="#/tickets" style="margin-left:auto;color:inherit">回任务</a></div>`
      return
    }
    if (!alive) return
    await loadExtras(data)
    if (!alive) return
    paint(data)
    // The repaint resets the file area to its button; reopen it quietly when the person had listed files.
    if (state.filesOpen) refreshFiles({ quiet: true })
    followActivity()
    anchorIntoView()
    ensureLiveTimer()
    ensureActTimer()
  }

  async function loadExtras(data) {
    const jobs = []
    if (data.council?.id) {
      state.councilError = ''
      jobs.push(get(`api/councils/${encodeURIComponent(data.council.id)}`)
        .then((council) => { state.council = council })
        .catch((error) => { state.council = null; state.councilError = error?.message || '会商记录没读出来' }))
    } else {
      state.council = null
    }
    jobs.push(loadActivity().catch(() => false))
    jobs.push(get(api('/deliverables'))
      .then((result) => { state.deliverables = Array.isArray(result?.items) ? result.items : [] })
      .catch(() => { state.deliverables = [] }))
    jobs.push(get('api/councils', { ticketId: id, limit: 10 })
      .then((result) => { state.history = Array.isArray(result?.items) ? result.items : [] })
      .catch(() => { state.history = [] }))
    if (state.liveId && state.liveId !== data.council?.id) {
      jobs.push(get(`api/councils/${encodeURIComponent(state.liveId)}`)
        .then((council) => { state.live = council })
        .catch(() => { state.live = null; state.liveId = '' }))
    }
    await Promise.all(jobs)
  }

  function paint(data) {
    state.current = data
    const ticket = data
    const usage = data.usage ?? {}
    const question = data.attention?.question
    const files = data.workspace ?? {}
    const events = Array.isArray(data.events) ? data.events : []
    const reports = Array.isArray(data.reports) ? data.reports : []
    const secretNames = Array.isArray(data.secrets) ? data.secrets : []
    const previews = Array.isArray(data.previews) ? data.previews : []
    const links = (Array.isArray(data.links) ? data.links : [])
      .filter((link) => link && /^https?:\/\//i.test(String(link.url ?? '')))
    const ended = data.status === 'ended' || data.stage?.stage === 'ended'

    const latestReport = reports.length ? reports[reports.length - 1] : null
    const timeline = [
      ...events.map((event) => ({
        at: event.at,
        tone: event.level === 'warn' || event.level === 'error' ? 'human' : 'machine',
        text: event.text,
      })),
      ...reports.filter((report) => report.question).map((report) => ({
        at: report.at,
        tone: 'human',
        text: `提问：${report.question}`,
      })),
    ].sort((a, b) => String(a.at).localeCompare(String(b.at)))

    const result = `<div class="head">
        ${ctx.split ? '' : `<a class="btn btn--quiet" href="#/tickets" style="min-height:44px;padding:0 12px 0 4px;color:var(--ink-3)">${icons.back} 任务</a>`}
        <h1 class="detail__title" style="margin-top:8px">${esc(ticket.title)}</h1>
        <p class="head__sub">${stateWord(ticket)}${ticket.stageHint ? `，${esc(ticket.stageHint)}` : ''}，${esc(ago(ticket.createdAt))}受理，已用 ${money4(usage.totalUsd ?? ticket.costUsd ?? 0)}</p>
        ${modelLine(ticket.model)}
      </div>

      <div data-delete-host></div>

      <div class="detail">
        <div>
          ${question ? `<article class="ask">
            <span class="ask__kind">等你回答</span>
            <p class="ask__q">${esc(question)}</p>
            <p class="ask__hint">问题来自它最近一次报告；回答后它会在下一轮读到</p>
            <div class="replybox">
              <input class="input" type="text" placeholder="直接回一句" aria-label="回复这个问题" data-reply value="${esc(state.replyDraft)}">
              <button class="btn btn--human" type="button" data-action="reply">回复</button>
            </div>
            <div class="cv-ask-actions">
              ${!ended ? '<button class="btn btn--quiet" type="button" data-action="council-ask">召集会商</button>' : ''}
            </div>
          </article>` : ''}

          ${state.replyDraft && !question ? replyDraftCard() : ''}

          ${taskbookSection(data)}
          ${deliverablesSection()}
          ${projectSection(data)}

          ${reports.length ? tsection('reports', '报告', `
            <div class="card">
              ${latestReport.summary ? renderMarkdown(latestReport.summary) : '<p class="hint">（这份报告没有正文）</p>'}
              ${latestReport.question ? `<p class="hint" style="margin-top:8px;color:var(--human)">提问：${esc(latestReport.question)}</p>` : ''}
            </div>
            ${reports.length > 1 ? `<details class="disclose" data-keep="ticket.older-reports" style="margin-top:8px"><summary>更早的报告（${reports.length - 1} 份）</summary>
              <div class="thread" style="margin-top:8px">
                ${reports.slice(0, -1).reverse().map((report) => `<div class="ev" data-tone="machine">
                  <div class="ev__time">${esc(absTime(report.at))}</div>
                  <div class="ev__what">${esc(report.state)}</div>
                  <div class="ev__quote">${esc(report.summary)}</div>
                </div>`).join('')}
              </div>
            </details>` : ''}
          `, { count: `${reports.length} 份`, note: `${latestReport.state ?? ''}，${ago(latestReport.at)}`, id: 'report' }) : ''}

          ${tsection('secrets', '可用的密钥', `
            <div class="cv-tsec__actions">
              <button class="btn btn--quiet" type="button" data-action="secrets-manage">${state.secretsOpen ? '收起' : '管理'}</button>
            </div>
            <div class="chips">
              ${secretNames.length
                ? secretNames.map((name) => `<span class="chip chip--soft mono secret-chip">${esc(name)}</span>`).join('')
                : '<span class="hint">还没有授权任何密钥；AI 需要时可以向你要。</span>'}
            </div>
            <p class="hint" style="margin-top:8px">下一次 AI 开始干活时生效</p>
            <div data-secrets-picker></div>
          `, { count: secretNames.length ? `${secretNames.length} 个` : '' })}

          ${previews.length ? tsection('previews', '预览', `
            <div class="list">
              ${previews.map((preview) => {
                const url = preview.url || preview.path || ''
                return `<div class="row row--flat" data-preview-item>
                <span class="row__main">
                  <span class="row__title">${esc(preview.title || `端口 ${preview.port}`)}</span>
                  <span class="row__meta"><span class="mono preview__path">${esc(preview.path || '')}</span><span>端口 ${esc(preview.port ?? '—')}</span></span>
                </span>
                <span class="row__side preview__side">
                  <span class="tag" data-preview-state="${preview.active ? 'active' : 'paused'}">${preview.active ? '可访问' : '静态副本'}</span>
                  <a class="btn btn--quiet" href="${esc(url)}" target="_blank" rel="noopener">打开</a>
                  <button class="btn btn--quiet" type="button" data-copy-preview="${esc(url)}">复制</button>
                </span>
              </div>`
              }).join('')}
            </div>
          `, { count: `${previews.length} 个` }) : ''}

          ${links.length ? tsection('links', '链接', `
            <div class="list">
              ${links.map((link) => `<div class="row row--flat">
                <span class="row__main">
                  <span class="row__title">${esc(link.title || 'Pull Request')}</span>
                  <span class="row__meta"><span class="mono" style="overflow-wrap:anywhere">${esc(link.url)}</span></span>
                </span>
                <span class="row__side"><a class="btn btn--quiet" href="${esc(link.url)}" target="_blank" rel="noopener">打开</a></span>
              </div>`).join('')}
            </div>
          `, { count: `${links.length} 个` }) : ''}

          ${!ended || state.activity.length ? tsection('activity', '执行过程', `
            <div data-activity>${activityBody(ended)}</div>
            <p class="hint act__note">${ended ? '' : '每 2 秒更新。'}只保留这次服务启动以来最近 300 步；服务重启后会从头记。</p>
          `, { count: state.activity.length ? `${state.activity.length} 步` : '', note: state.activityAt ? `最近一步 ${ago(state.activityAt)}` : '' }) : ''}

          ${tsection('progress', '进展', `
            <div class="cv-tsec__actions">
              <a class="btn btn--quiet" href="#/events/${encodeURIComponent(ticket.id)}">只看这张票的事件</a>
            </div>
            ${timeline.length ? `<div class="thread">${timeline.map((item) => `
              <div class="ev" data-tone="${item.tone}">
                <div class="ev__time">${esc(absTime(item.at))}</div>
                <div class="ev__what">${esc(item.text)}</div>
              </div>`).join('')}</div>` : '<p class="hint">还没有事件。</p>'}
            ${!ended ? `<div class="cv-progress__actions"><button class="btn btn--quiet" type="button" data-action="council-ask">召集会商</button>
              <span class="hint">遇到要拍板的事，叫五个角色来议一下。</span></div>` : ''}
            ${liveSection()}
            ${historySection()}
          `, { count: timeline.length ? `${timeline.length} 条` : '' })}

          ${tsection('usage', '这张票的用量', `
            ${data.canRetry && !ended ? '<div class="cv-tsec__actions"><button class="btn btn--quiet" type="button" data-action="retry">重试</button></div>' : ''}
            <div class="kpi-row">
              <div class="kpi"><div class="kpi__k">花费</div><div class="kpi__v">${money4(usage.totalUsd ?? 0)}</div></div>
              <div class="kpi"><div class="kpi__k">调用</div><div class="kpi__v">${usage.calls ?? 0} 次</div></div>
              <div class="kpi"><div class="kpi__k">前缀命中</div><div class="kpi__v">${Math.round(Number(usage.hitRate ?? 0) * 100)}%</div></div>
            </div>
          `, { count: money4(usage.totalUsd ?? 0) })}

          ${tsection('files', '工作区文件', `
            ${files.path ? `<p class="hint">${esc(files.path)}</p>` : ''}
            <div data-files>
              ${state.filesOpen && state.filesHtml
                ? state.filesHtml
                : files.fileCount ? '<button class="btn" type="button" data-action="files">列出文件</button>' : '<p class="hint">还没有产出文件。它干活时写的文件都会出现在这里。</p>'}
            </div>
          `, { count: `${files.fileCount ?? 0} 个` })}

          <details class="disclose" data-keep="ticket.more-info" style="margin-top:18px">
            <summary>更多信息</summary>
            <dl class="kvs" style="margin-top:10px">
              <dt>编号</dt><dd class="mono">${esc(ticket.id)}</dd>
              <dt>授权</dt><dd>${esc(ticket.mandate?.strength ?? '—')}，来自 ${esc(ticket.mandate?.actor?.id ?? '—')}</dd>
              <dt>范围</dt><dd>${esc(ticket.mandate?.scope ?? '—')}</dd>
              <dt>模型</dt><dd>${esc(ticket.model?.label ?? '—')}（${esc(SOURCE[ticket.model?.source] ?? '默认')}）</dd>
              <dt>目录</dt><dd class="mono">${esc(files.path || '—')}</dd>
              ${data.delivery ? `<dt>投递</dt><dd>失败：${esc(data.delivery.error)}</dd>` : ''}
            </dl>
          </details>
          <p class="hint-row"><span class="kbd">Esc</span> 返回任务</p>
        </div>

        <div class="detail__side">
          <div class="card">
            <div class="card__title">这张工单</div>
            <dl class="kvs" style="margin-top:10px">
              <dt>花费</dt><dd>${money4(usage.totalUsd ?? 0)}</dd>
              <dt>模型</dt><dd>${esc(ticket.model?.label ?? '—')}</dd>
              <dt>文件</dt><dd>${files.fileCount ?? 0} 个</dd>
              <dt>状态</dt><dd>${esc(ticket.stageLabel || '—')}</dd>
            </dl>
          </div>
        </div>
      </div>

      <div class="stickybar">
        <button class="btn ${ended ? '' : 'btn--danger'}" type="button" data-action="stop" ${ended ? 'disabled' : ''}>停止</button>
        <button class="btn" type="button" data-action="note">备注</button>
        <button class="btn btn--ink" type="button" data-action="reply-open">新指令</button>
        <button class="btn btn--danger" type="button" data-action="delete">删除任务</button>
      </div>
      ${councilDialog(data)}`
    root.innerHTML = result
    renderDeletePanel()
    paintSecretPicker()
  }

  function replyDraftCard() {
    return `<article class="ask cv-reply-draft">
      <span class="ask__kind">会商建议已填好</span>
      <p class="ask__hint">这是会商给的建议。确认或改一改，再点「送过去」；不会自动发出。</p>
      <div class="cv-adopt">
        <textarea class="textarea cv-adopt__text" rows="3" data-adopt-text aria-label="回复会商建议">${esc(state.replyDraft)}</textarea>
        <button class="btn btn--human" type="button" data-action="adopt-send">送过去</button>
      </div>
    </article>`
  }

  function taskbookSection(data) {
    if (!data.council?.id) return ''
    const council = state.council
    const status = council?.status ?? data.council.status
    if (!council?.brief) {
      const note = state.councilError
        ? `会商记录没读出来：${esc(state.councilError)}`
        : status === 'running'
          ? '会商还在进行，主持人汇总完后这里会出现任务书。'
          : '这场会商还没有任务书。'
      return `<section class="section cv-ticketbrief">
        <div class="section__head"><h2 class="section__title">任务书</h2><span class="section__count">${esc(statusWord(status))}</span></div>
        <p class="hint">${note}</p>
        <p><a class="btn btn--quiet" href="#/council/${encodeURIComponent(data.council.id)}" style="padding-left:0">查看会商记录</a></p>
      </section>`
    }
    return `<details class="disclose cv-ticketbrief" data-keep="ticket.brief" open>
      <summary><span class="cv-ticketbrief__title">任务书</span><span class="cv-count">${esc(statusWord(status))}</span></summary>
      <div class="cv-ticketbrief__body">
        ${briefHtml(council.brief)}
        <p class="cv-ticketbrief__link"><a href="#/council/${encodeURIComponent(data.council.id)}">查看会商记录</a></p>
      </div>
    </details>`
  }

  function deliverablesSection() {
    const items = [...state.deliverables].sort((a, b) => {
      const aMd = a.kind === 'md'
      const bMd = b.kind === 'md'
      if (aMd !== bMd) return aMd ? -1 : 1
      return Date.parse(b.mtime ?? 0) - Date.parse(a.mtime ?? 0)
    })
    return `<details class="disclose cv-deliverables" data-keep="ticket.deliverables" open>
      <summary><span class="cv-deliverables__title">产出文档</span><span class="cv-count">${items.length} 个</span></summary>
      <div class="cv-deliverables__body">
        ${items.length ? `<div class="list">${items.map((item) => {
          const path = String(item.path ?? '')
          const name = path.split('/').pop() || path
          const kind = String(item.kind || path.split('.').pop() || '').toLowerCase()
          const href = READABLE.has(kind)
            ? `#/doc/ticket/${encodeURIComponent(id)}?path=${encodeURIComponent(path)}`
            : `${api('/files')}?path=${encodeURIComponent(path)}&download=1`
          return `<div class="row row--flat cv-file">
            <span class="row__main">
              <span class="row__title">${esc(name)}</span>
              <span class="row__meta"><span>${bytes(item.size ?? 0)}</span><span>${esc(ago(item.mtime))}</span></span>
            </span>
            <span class="row__side"><a class="btn btn--quiet" href="${href}"${READABLE.has(kind) ? '' : ' download'}>${READABLE.has(kind) ? '阅读' : '下载'}</a></span>
          </div>`
        }).join('')}</div>` : '<p class="hint">任务完成后，给人看的文档会出现在这里。</p>'}
      </div>
    </details>`
  }

  function projectSection(data) {
    if (!data.project?.id) return ''
    return tsection('project', '项目', `
      <p class="cv-project__line">
        <a class="cv-badge" href="#/projects/${encodeURIComponent(data.project.id)}">${esc(data.project.name || data.project.id)}</a>
        ${data.project.preparing ? '<span class="cv-project__note">正在准备项目文件，第一次会慢一些</span>' : ''}
      </p>
      <div class="bar-actions">
        <a class="btn" href="${api('/archive')}?path=project" download>导出项目</a>
        <a class="btn" href="${api('/archive')}?path=output" download>导出产出</a>
      </div>
      <p class="hint">会打成 .tar.gz，项目大时需要等一会儿。</p>
    `, { count: data.project.preparing ? '准备中' : '' })
  }

  function liveSection() {
    const live = state.live
    if (!live) return ''
    const advice = live.brief ? decisionParts(live.brief).advice : ''
    return `<details class="cv-live" data-keep="ticket.council-live" open>
      <summary class="cv-live__summary">
        <span class="cv-mode">${esc(modeWord(live.mode))}</span>
        <span class="cv-status__word"><span class="cv-mark" aria-hidden="true"></span>${esc(statusWord(live.status))}</span>
        <span class="cv-count">${esc(roundProgress(live))}</span>
      </summary>
      <div class="cv-live__body">
        ${live.status === 'running' ? '<p class="hint">每 1.5 秒自动更新；新的发言会接在下面，不会把正在看的位置顶走。</p>' : ''}
        <details class="cv-live__turns" data-keep="ticket.council-turns-${esc(live.status)}"${live.status === 'running' ? ' open' : ''}>
          <summary>各角色发言（${Array.isArray(live.rounds) ? live.rounds.length : 0} 轮）</summary>
          ${roundsHtml(live.rounds)}
        </details>
        ${live.status === 'failed' ? `<p class="cv-error" role="alert">${esc(live.error || '这次会商没能完成。')}</p>
          <p><a class="btn btn--quiet" href="#/council/${encodeURIComponent(live.id)}" style="padding-left:0">在会商室打开</a></p>` : ''}
        ${live.brief ? `<div class="cv-live__decision">${decisionHtml(live.brief)}</div>
          <div class="cv-actions">
            <button class="btn btn--human" type="button" data-action="council-adopt">采纳并回复</button>
            <a class="btn" href="#/council/${encodeURIComponent(live.id)}">在会商室打开</a>
          </div>
          ${state.replyDraft ? `<div class="cv-adopt">
            <p class="hint">建议已填好，确认或改一改再送过去；不会自动发出。</p>
            <textarea class="textarea cv-adopt__text" rows="3" data-adopt-text aria-label="回复会商建议">${esc(state.replyDraft || advice)}</textarea>
            <button class="btn btn--human" type="button" data-action="adopt-send">送过去</button>
          </div>` : ''}
        ` : ''}
      </div>
    </details>`
  }

  function historySection() {
    const items = state.history.filter((item) => item.mode === 'decision' && item.id !== state.live?.id)
    if (!items.length) return ''
    return `<div class="cv-history">
      <div class="cv-history__title">之前的会商</div>
      ${items.map((item) => `<a class="cv-history__row" href="#/council/${encodeURIComponent(item.id)}">
        <span class="cv-history__mode">${esc(modeWord(item.mode))}</span>
        <span class="cv-history__topic">${esc(item.topic)}</span>
        <span class="cv-history__meta">${esc(statusWord(item.status))}，${esc(ago(item.createdAt))}</span>
      </a>`).join('')}
    </div>`
  }

  function councilDialog(data) {
    const ended = data.status === 'ended' || data.stage?.stage === 'ended'
    if (ended) return ''
    const topic = data.attention?.question || data.title || ''
    return `<dialog class="cv-dialog" data-council-dialog aria-labelledby="cv-dialog-title">
      <div class="cv-dialog__body">
        <h2 class="cv-dialog__title" id="cv-dialog-title">召集一次会商</h2>
        <p class="hint">五个角色会各说一轮，主持人给出建议。不会自动回复或改动任务。</p>
        <label class="field" for="cv-council-topic">
          <span class="field__label">要议什么</span>
          <textarea class="textarea" id="cv-council-topic" rows="3" data-council-topic>${esc(topic)}</textarea>
        </label>
        <p class="cv-error" data-council-error role="alert" hidden></p>
        <div class="bar-actions">
          <button class="btn" type="button" data-action="council-cancel">再想想</button>
          <button class="btn btn--human" type="button" data-action="council-create" ${state.busy ? 'disabled' : ''}>开始会商</button>
        </div>
      </div>
    </dialog>`
  }

  function paintSecretPicker() {
    const host = root.querySelector('[data-secrets-picker]')
    if (!host) return
    if (!state.secretsOpen) {
      host.innerHTML = ''
      return
    }
    if (state.secretChoicesError) {
      host.innerHTML = `<p class="hint" style="margin-top:8px">读不到密钥库：${esc(state.secretChoicesError)}</p>`
      return
    }
    if (!state.secretChoices) {
      host.innerHTML = '<p class="hint" style="margin-top:8px">正在读取密钥库…</p>'
      return
    }
    if (!state.secretChoices.length) {
      host.innerHTML = '<p class="hint" style="margin-top:8px">密钥库里还没有密钥，先去「密钥」页添加。</p>'
      return
    }
    host.innerHTML = `<div class="card" style="margin-top:10px">
      <p class="hint" style="margin-bottom:4px">勾选这张任务可以用的密钥。保存后，下一次 AI 开始干活时生效。</p>
      <div class="secret-picker">
        ${state.secretChoices.map((secret) => `<label class="checkline">
          <input type="checkbox" data-secret-choice value="${esc(secret.name)}" ${state.secretSelected.has(secret.name) ? 'checked' : ''}>
          <span><span class="mono">${esc(secret.name)}</span>${secret.description ? `<span class="hint"> · ${esc(secret.description)}</span>` : ''}</span>
        </label>`).join('')}
      </div>
      <div class="bar-actions" style="margin-top:10px">
        <button class="btn btn--human" type="button" data-action="secrets-save" ${state.secretsBusy ? 'disabled' : ''}>${state.secretsBusy ? '保存中…' : '保存授权'}</button>
        <button class="btn" type="button" data-action="secrets-cancel">取消</button>
      </div>
    </div>`
  }

  async function loadSecretChoices() {
    try {
      const data = await get('api/secrets')
      if (!alive) return
      const items = Array.isArray(data?.items) ? data.items : []
      state.secretChoices = items
      const names = new Set(items.map((item) => item.name))
      for (const name of [...state.secretSelected]) {
        if (!names.has(name)) state.secretSelected.delete(name)
      }
      state.secretChoicesError = ''
    } catch (error) {
      if (error?.status === 401) return
      state.secretChoices = []
      state.secretChoicesError = error?.message || '请求失败'
    }
    paintSecretPicker()
  }

  function renderDeletePanel() {
    const host = root.querySelector('[data-delete-host]')
    if (!host) return
    const ticket = state.current
    if (!state.deleteOpen || !ticket) {
      host.innerHTML = ''
      return
    }
    const last4 = String(ticket.id).slice(-4)
    const open = ticket.status !== 'ended' && ticket.stage?.stage !== 'ended'
    const ready = state.deleteText.trim() === last4
    host.innerHTML = `
      <article class="card confirm" role="region" aria-label="删除任务确认">
        <h2 class="confirm__title">删除这张任务？</h2>
        <p class="confirm__text">会删除任务记录、工作区文件和 AI 配置；花费记录会保留。删掉后不能恢复。</p>
        ${open ? '<p class="confirm__warn">任务还在进行，删除前会先停止它。</p>' : ''}
        <label class="checkline">
          <input type="checkbox" data-delete-workspace ${state.deleteWorkspace ? 'checked' : ''}>
          <span>同时删除工作区文件</span>
        </label>
        <div class="field" style="margin-top:8px">
          <label class="field__label" for="delete-confirm-input">输入编号后 4 位 <code>${esc(last4)}</code> 来确认</label>
          <input class="input" id="delete-confirm-input" data-delete-text value="${esc(state.deleteText)}"
            autocomplete="off" spellcheck="false" placeholder="${esc(last4)}">
        </div>
        <div class="bar-actions">
          <button class="btn" type="button" data-action="delete-cancel">再想想</button>
          <button class="btn btn--danger" type="button" data-action="delete-confirm" ${ready ? '' : 'disabled'}>确认删除</button>
        </div>
      </article>`
  }

  function anchorIntoView() {
    if (!location.hash.includes('#report')) return
    const node = root.querySelector('#report')
    if (node) node.scrollIntoView({ block: 'start', behavior: 'smooth' })
  }

  async function refreshFiles({ quiet = false } = {}) {
    const host = root.querySelector('[data-files]')
    if (!host) return
    state.filesOpen = true
    if (!quiet) host.innerHTML = '<p class="hint">正在读文件…</p>'
    // Every result is also kept in state.filesHtml, so paint() rebuilds the open listing instead of the button.
    const show = (html) => {
      state.filesHtml = html
      const live = root.querySelector('[data-files]')
      if (live) live.innerHTML = html
    }
    try {
      const data = await get(api(`/files${state.filePath ? `?path=${encodeURIComponent(state.filePath)}` : ''}`))
      if (!alive) return
      if (data?.type === 'file') {
        const ext = String(data.name || data.path || '').split('.').pop().toLowerCase()
        const image = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif'].includes(ext)
        const rawUrl = `${api('/files')}?path=${encodeURIComponent(state.filePath)}&raw=1`
        const body = image
          ? `<img class="file-preview" alt="${esc(data.name || '')}" src="${esc(rawUrl)}">`
          : data.binary
            ? '<p class="hint" style="margin-top:8px">这是二进制文件，不能在线预览；图片可以直接看。</p>'
            : ext === 'md'
              ? `${renderMarkdown(data.text ?? '')}${data.truncated ? '<p class="hint">文件太大，只显示了开头一段。</p>' : ''}`
              : `<pre class="code-box" style="margin-top:8px;white-space:pre-wrap">${esc(data.text ?? '')}</pre>${data.truncated ? '<p class="hint">文件太大，只显示了开头一段。</p>' : ''}`
        show(`
          <div class="card">
            <div class="card__head" style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
              <span class="mono">${esc(data.path || data.name || '')}</span>
              <span class="hint">${bytes(data.size ?? 0)}</span>
              <button class="btn btn--quiet" type="button" data-action="files-back" style="margin-left:auto">返回</button>
            </div>
            ${body}
          </div>`)
        return
      }
      const entries = Array.isArray(data?.entries) ? data.entries : []
      if (!entries.length) {
        show('<p class="hint">这个文件夹是空的。</p>')
        return
      }
      show(`
        <div class="files">
          ${entries.map((entry) => `<button class="file" type="button" data-path="${esc([state.filePath, entry.name].filter(Boolean).join('/'))}" data-kind="${entry.type}">
            <span>${entry.type === 'dir' ? '📁 ' : ''}${esc(entry.name)}</span>
            ${entry.size !== undefined ? `<span class="file__size">${bytes(entry.size)}</span>` : ''}
          </button>`).join('')}
        </div>
        ${state.filePath ? '<button class="btn btn--quiet" type="button" data-action="files-back" style="margin-top:8px;padding-left:0">回到上一层</button>' : ''}`)
    } catch (error) {
      show(`<p class="hint">读不到文件：${esc(error?.message || '请求失败')}</p>`)
    }
  }

  async function act(run, message) {
    if (state.busy) return
    state.busy = true
    try {
      await run()
      bus.toast(message)
      invalidateOverview()
      await bus.refreshOverview()
      await render()
    } catch (error) {
      bus.toast(error?.message || '操作没有成功', { danger: true })
    } finally {
      state.busy = false
    }
  }

  const ACT_TOOL = { bash: '命令', read: '读文件', write: '写文件', edit: '改文件', ls: '列目录', grep: '搜索', find: '找文件' }

  const isEnded = (data) => Boolean(data) && (data.status === 'ended' || data.stage?.stage === 'ended')

  function clock(at) {
    const date = new Date(at)
    if (Number.isNaN(date.getTime())) return ''
    return date.toLocaleTimeString('zh-CN', { hour12: false })
  }

  function seconds(ms) {
    const value = Number(ms) || 0
    return value < 1000 ? `${value} 毫秒` : `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)} 秒`
  }

  function actRow(entry) {
    const key = entry.id ?? entry.seq
    const label = entry.kind === 'tool'
      ? (ACT_TOOL[entry.tool] || entry.tool || '工具')
      : entry.kind === 'say' ? '说' : entry.kind === 'think' ? '想' : '节点'
    const status = entry.status === 'running'
      ? '<span class="act__st" data-st="running">进行中</span>'
      : entry.status === 'error'
        ? '<span class="act__st" data-st="error">出错</span>'
        : entry.ms ? `<span class="act__ms">${esc(seconds(entry.ms))}</span>` : ''
    const detail = entry.detail && entry.detail !== entry.summary
      ? `<details class="act__more" data-keep="ticket.act-${esc(key)}"><summary>${entry.kind === 'tool' ? '看输出' : '看全文'}</summary><pre class="act__out">${esc(entry.detail)}</pre></details>`
      : ''
    return `<li class="act__i" data-kind="${esc(entry.kind)}">
      <span class="act__t">${esc(clock(entry.at))}</span>
      <span class="act__k">${esc(label)}</span>
      <span class="act__s${entry.kind === 'tool' ? ' mono' : ''}">${esc(entry.summary || (entry.kind === 'tool' ? '（没有参数）' : ''))}</span>
      ${status}
      ${detail}
    </li>`
  }

  function activityBody(ended) {
    if (!state.activity.length) {
      return `<p class="hint">${ended
        ? '这张任务已经结束，这次服务启动以来没有记录到它的步骤。'
        : '还没有记录到步骤：它可能在排队、在准备项目文件，或者服务刚重启过。新步骤会出现在这里。'}</p>`
    }
    return `<ol class="act" data-keep-scroll="ticket.activity" data-act-log aria-live="polite">${state.activity.map(actRow).join('')}</ol>`
  }

  /** Fetch steps newer than the last one seen. Returns true when something new arrived. */
  async function loadActivity() {
    const data = await get(api('/activity'), state.activityLast ? { after: state.activityLast } : { limit: 200 })
    if (!alive) return false
    const last = Number(data?.last) || 0
    if (last < state.activityLast) {
      // The daemon restarted and its log began again: start over instead of waiting for numbers it will never reach.
      state.activity = []
      state.activityLast = 0
      state.activityAt = ''
      return loadActivity()
    }
    const items = Array.isArray(data?.items) ? data.items : []
    state.activityLast = Math.max(state.activityLast, last)
    if (data?.updatedAt) state.activityAt = data.updatedAt
    if (!items.length) return false
    const byId = new Map(state.activity.map((entry) => [entry.id ?? entry.seq, entry]))
    for (const item of items) byId.set(item.id ?? item.seq, item)
    state.activity = [...byId.values()].sort((a, b) => a.seq - b.seq).slice(-300)
    return true
  }

  function followActivity() {
    if (!state.actFollow) return
    const log = root.querySelector('[data-act-log]')
    if (log) log.scrollTop = log.scrollHeight
  }

  /** Redraw only the step list and its counters; the rest of the page is left alone. */
  function paintActivity() {
    const host = root.querySelector('[data-activity]')
    if (!host || !state.current) {
      // The section is not on the page yet (the ticket ended before any step was seen): a full paint adds it.
      if (state.current && !root.querySelector('[data-activity]') && state.activity.length) {
        const snap = keep.snapshot(root)
        paint(state.current)
        keep.restore(root, snap)
        followActivity()
      }
      return
    }
    const old = host.querySelector('[data-act-log]')
    const top = old ? old.scrollTop : 0
    host.innerHTML = activityBody(isEnded(state.current))
    const section = host.closest('details')
    const count = section?.querySelector(':scope > summary .section__count')
    if (count) count.textContent = `${state.activity.length} 步`
    const note = section?.querySelector(':scope > summary .section__note')
    if (note && state.activityAt) note.textContent = `最近一步 ${ago(state.activityAt)}`
    const log = host.querySelector('[data-act-log]')
    if (log) log.scrollTop = state.actFollow ? log.scrollHeight : top
  }

  function stopActTimer() {
    if (actTimer) window.clearInterval(actTimer)
    actTimer = null
  }

  function ensureActTimer() {
    const should = alive && Boolean(state.current) && !isEnded(state.current) && !document.hidden
    if (should && !actTimer) {
      actTimer = window.setInterval(() => {
        loadActivity().then((changed) => { if (changed && alive) paintActivity() }).catch(() => {})
      }, 2000)
    }
    if (!should) stopActTimer()
  }

  function stopLiveTimer() {
    if (liveTimer) window.clearInterval(liveTimer)
    liveTimer = null
  }

  function ensureLiveTimer() {
    const should = alive && state.live?.status === 'running' && !document.hidden && !state.dialogOpen
    if (should && !liveTimer) liveTimer = window.setInterval(() => { pollLive().catch(() => {}) }, 1500)
    if (!should) stopLiveTimer()
  }

  async function pollLive() {
    if (!alive || !state.liveId) return
    const snap = keep.snapshot(root)
    try {
      const live = await get(`api/councils/${encodeURIComponent(state.liveId)}`)
      if (!alive) return
      state.live = live
      if (state.current) {
        paint(state.current)
        keep.restore(root, snap)
      }
    } catch { /* the next tick tries again */ }
    ensureLiveTimer()
  }

  function openCouncilDialog() {
    const dialog = root.querySelector('[data-council-dialog]')
    if (!dialog) return
    state.dialogOpen = true
    if (typeof dialog.showModal === 'function') dialog.showModal()
    else dialog.setAttribute('open', '')
    const field = dialog.querySelector('[data-council-topic]')
    field?.focus()
    if (field) field.setSelectionRange(field.value.length, field.value.length)
    ensureLiveTimer()
  }

  function closeCouncilDialog() {
    const dialog = root.querySelector('[data-council-dialog]')
    state.dialogOpen = false
    if (!dialog) return
    if (typeof dialog.close === 'function') dialog.close()
    else dialog.removeAttribute('open')
    ensureLiveTimer()
  }

  async function createCouncil() {
    const dialog = root.querySelector('[data-council-dialog]')
    const field = dialog?.querySelector('[data-council-topic]')
    const error = dialog?.querySelector('[data-council-error]')
    const text = String(field?.value ?? '').trim()
    if (!text) {
      if (error) { error.hidden = false; error.textContent = '先写一句要议什么。' }
      field?.focus()
      return
    }
    if (error) error.hidden = true
    state.busy = true
    try {
      const result = await post('api/councils', { mode: 'decision', text, ticketId: id })
      const councilId = result?.id
      if (!councilId) throw new Error('会商没有开起来，请重试。')
      state.liveId = councilId
      try { sessionStorage.setItem(`sa-ticket-council-${id}`, councilId) } catch { /* private mode */ }
      state.live = await get(`api/councils/${encodeURIComponent(councilId)}`)
      state.dialogOpen = false
      if (dialog && typeof dialog.close === 'function') dialog.close()
      bus.toast('会商开始了')
      paint(state.current)
      ensureLiveTimer()
    } catch (errorObject) {
      if (error) {
        error.hidden = false
        error.textContent = errorObject?.message || '没能召集会商，请重试。'
      }
      bus.toast(errorObject?.message || '没能召集会商', { danger: true })
    } finally {
      state.busy = false
    }
  }

  function adoptCouncilAdvice() {
    if (!state.live?.brief) return
    const advice = decisionParts(state.live.brief).advice
    state.replyDraft = advice
    paint(state.current)
    requestAnimationFrame(() => {
      const target = root.querySelector('[data-adopt-text]') || root.querySelector('[data-reply]')
      if (target) {
        target.focus({ preventScroll: true })
        target.scrollIntoView({ block: 'center', behavior: 'smooth' })
      }
    })
  }

  async function sendAdoptedReply() {
    const field = root.querySelector('[data-adopt-text]')
    const text = String(field?.value ?? state.replyDraft).trim()
    if (!text) return
    state.replyDraft = ''
    await act(() => post(api('/reply'), { text }), '已回复')
  }

  root.addEventListener('click', async (event) => {
    const copyButton = event.target.closest('[data-copy-preview]')
    if (copyButton) {
      await copyText(copyButton.dataset.copyPreview, '链接已复制')
      return
    }
    const action = event.target.closest('[data-action]')?.dataset.action
    const fileButton = event.target.closest('.file')
    if (fileButton) {
      const kind = fileButton.dataset.kind
      const path = fileButton.dataset.path
      if (kind === 'dir') { state.filePath = path; await refreshFiles(); return }
      state.filePath = path
      await refreshFiles()
      return
    }
    if (!action) return

    if (action === 'secrets-manage') {
      state.secretsOpen = !state.secretsOpen
      if (state.secretsOpen) {
        state.secretSelected = new Set(Array.isArray(state.current?.secrets) ? state.current.secrets : [])
        state.secretChoices = null
        state.secretChoicesError = ''
        if (state.current) paint(state.current)
        await loadSecretChoices()
      } else if (state.current) {
        paint(state.current)
      }
      return
    }
    if (action === 'secrets-cancel') {
      state.secretsOpen = false
      if (state.current) paint(state.current)
      return
    }
    if (action === 'secrets-save') {
      if (state.secretsBusy) return
      state.secretsBusy = true
      paintSecretPicker()
      try {
        const names = [...state.secretSelected]
        await put(api('/secrets'), { names })
        state.secretsBusy = false
        state.secretsOpen = false
        bus.toast('已保存，下一次 AI 开始干活时生效')
        await render()
      } catch (error) {
        state.secretsBusy = false
        bus.toast(error?.message || '保存没有成功', { danger: true })
        paintSecretPicker()
      }
      return
    }

    if (action === 'council-ask') { openCouncilDialog(); return }
    if (action === 'council-cancel') { closeCouncilDialog(); return }
    if (action === 'council-create') { await createCouncil(); return }
    if (action === 'council-adopt') { adoptCouncilAdvice(); return }
    if (action === 'adopt-send') { await sendAdoptedReply(); return }

    if (action === 'delete') {
      state.deleteOpen = true
      state.deleteWorkspace = true
      state.deleteText = ''
      renderDeletePanel()
      root.querySelector('[data-delete-text]')?.focus()
      return
    }
    if (action === 'delete-cancel') {
      state.deleteOpen = false
      state.deleteText = ''
      renderDeletePanel()
      root.querySelector('[data-action="delete"]')?.focus()
      return
    }
    if (action === 'delete-confirm') {
      const ticket = state.current
      if (!ticket || state.busy) return
      const last4 = String(ticket.id).slice(-4)
      if (state.deleteText.trim() !== last4) {
        bus.toast('编号后 4 位不对，请重新输入。', { danger: true })
        return
      }
      const open = ticket.status !== 'ended' && ticket.stage?.stage !== 'ended'
      state.busy = true
      const button = root.querySelector('[data-action="delete-confirm"]')
      if (button) button.disabled = true
      try {
        const result = await del(api(''), {
          deleteWorkspace: state.deleteWorkspace,
          ...(open ? { force: true } : {}),
        })
        state.deleteOpen = false
        bus.toast(`已删除，释放了 ${bytes(result?.freedBytes ?? 0)}`)
        invalidateOverview()
        bus.refreshOverview?.()
        bus.navigate('tickets')
      } catch (error) {
        bus.toast(error?.message || '删除没有成功', { danger: true })
        if (button) button.disabled = false
      } finally {
        state.busy = false
      }
      return
    }

    if (action === 'reply') {
      const text = root.querySelector('[data-reply]')?.value?.trim()
      if (!text) return
      state.replyDraft = ''
      await act(() => post(api('/reply'), { text }), '已回复')
      return
    }
    if (action === 'reply-open') {
      const current = state.current
      // Same rule as the server: ended, or waiting on a person (failed / blocked / timed out), or a failed delivery.
      const restart = isEnded(current) || Boolean(current?.canRetry)
      // The models a person can switch to; the ticket's current one is preselected, so leaving it changes nothing.
      let options = []
      try {
        const list = await get('api/models')
        options = (Array.isArray(list?.items) ? list.items : []).map((item) => ({ value: item.ref, label: `${item.providerName} · ${item.label}` }))
      } catch { /* without the list the sheet just has no model choice */ }
      const currentRef = current?.model?.ref ?? ''
      if (currentRef && !options.some((option) => option.value === currentRef)) {
        options.unshift({ value: currentRef, label: `${current?.model?.label || currentRef}（当前）` })
      }
      const values = await bus.sheet({
        title: '给这个任务发新指令',
        text: restart
          ? '它现在停着（失败、超时、已完成或被停止）。发出后会在原来的工作区里重新开工，按这条指令接着干。'
          : '它正在干活，这条指令会在它的下一步送到。',
        confirmLabel: restart ? '发出并继续' : '发出',
        field: { id: 'text', label: '指令', placeholder: '例如：接着把截图测试跑完，再把视频导出来' },
        select: options.length > 1 ? {
          id: 'model', label: '用哪个模型执行', options, value: currentRef,
          help: '换成别的模型时，从这一轮起改用它；工作区和之前的进度都保留。正在跑的这一轮会先停下再换。',
        } : undefined,
      })
      const text = values?.text?.trim()
      if (!text) return
      const model = values?.model && values.model !== currentRef ? values.model : ''
      const message = model ? '已发出，换模型后重新开工' : restart ? '已发出，任务重新开工' : '已发出'
      await act(() => post(api('/reply'), { text, ...(model ? { model } : {}) }), message)
      return
    }
    if (action === 'note') {
      const values = await bus.sheet({
        title: '留一句备注',
        text: '备注只作为上下文送到它那里，不会触发模型，也不改状态。',
        confirmLabel: '送过去',
        field: { id: 'text', label: '备注', placeholder: '例如：先别改配置' },
      })
      const text = values?.text?.trim()
      if (text) await act(() => post(api('/note'), { text }), '已送到')
      return
    }
    if (action === 'retry') { await act(() => post(api('/retry'), {}), '已重新排队'); return }
    if (action === 'stop') {
      const values = await bus.sheet({
        title: '停止这张工单？',
        text: '停止后它不再继续，已经花的钱不退；之后在这个任务里点「新指令」就能让它接着干。',
        confirmLabel: '停止',
        danger: true,
        field: { id: 'reason', label: '原因（可选，会记进事件）', placeholder: '例如：方向不对，先别跑了' },
      })
      if (!values) return
      const reason = values.reason?.trim()
      await act(() => post(api('/stop'), reason ? { reason } : {}), '已停止')
      return
    }
    if (action === 'files') { await refreshFiles(); return }
    if (action === 'files-back') {
      state.filePath = ''
      await refreshFiles()
    }
  })

  root.addEventListener('input', (event) => {
    if (!event.target.matches('[data-delete-text]')) return
    state.deleteText = event.target.value
    const last4 = String(state.current?.id ?? '').slice(-4)
    const confirm = root.querySelector('[data-action="delete-confirm"]')
    if (confirm) confirm.disabled = state.deleteText.trim() !== last4
  })

  root.addEventListener('change', (event) => {
    if (event.target.matches('[data-secret-choice]')) {
      if (event.target.checked) state.secretSelected.add(event.target.value)
      else state.secretSelected.delete(event.target.value)
      return
    }
    if (event.target.matches('[data-delete-workspace]')) {
      state.deleteWorkspace = event.target.checked
    }
  })

  root.addEventListener('close', (event) => {
    if (event.target?.matches?.('[data-council-dialog]')) {
      state.dialogOpen = false
      ensureLiveTimer()
    }
  }, true)

  const onVisibility = () => {
    ensureLiveTimer()
    ensureActTimer()
    if (!document.hidden && state.live?.status === 'running') pollLive().catch(() => {})
  }
  document.addEventListener('visibilitychange', onVisibility)

  // Scrolling the step list up stops it from following new lines; scrolling back to the bottom resumes following.
  root.addEventListener('scroll', (event) => {
    const log = event.target
    if (!(log instanceof Element) || !log.matches('[data-act-log]')) return
    state.actFollow = log.scrollHeight - log.scrollTop - log.clientHeight < 24
  }, { capture: true, passive: true })

  render().catch(() => {})
  return {
    root,
    refresh: () => (state.deleteOpen || state.secretsOpen || state.dialogOpen ? Promise.resolve() : render()),
    destroy() {
      alive = false
      stopLiveTimer()
      stopActTimer()
      document.removeEventListener('visibilitychange', onVisibility)
    },
  }
}
