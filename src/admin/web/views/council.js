/** 会商室: the meeting minutes, then the task book the moderator wrote. */
import { get, post, del, invalidateOverview } from '../lib/api.js'
import { bus } from '../lib/bus.js'
import * as keep from '../lib/keep.js'
import { esc, money4, emptyHtml, icons } from '../lib/view.js'
import { parseBrief, appendConfirmations } from '../lib/brief.js'
import {
  modeWord, statusWord, roundProgress, roundsHtml, hostNoteHtml, briefHtml,
  decisionHtml, decisionParts, copyText,
} from '../lib/council-view.js'

export function mount(ctx) {
  const id = ctx.params.id
  const root = document.createElement('div')
  root.className = 'page'
  const state = {
    data: null,
    notFound: false,
    loadError: '',
    busy: false,
    editing: false,
    draft: '',
    briefSource: '',
    questions: [],
    answers: {},
    error: '',
    model: '',
    models: [],
    modelsLoaded: false,
  }
  let alive = true
  let timer = null
  // Project id -> name once looked up; null when the lookup failed (keeps the word 关联项目).
  const projectNames = new Map()
  const projectAsked = new Set()

  function loadProjectName(projectId) {
    if (!projectId || projectAsked.has(projectId)) return
    projectAsked.add(projectId)
    get(`api/projects/${encodeURIComponent(projectId)}`)
      .then((project) => {
        const name = String(project?.name ?? '').trim()
        if (name) projectNames.set(projectId, name)
        else return
        if (!alive) return
        const badge = root.querySelector('[data-project-badge]')
        if (badge) badge.textContent = name
      })
      .catch(() => { /* keep the word 关联项目; never show the raw id */ })
  }

  const api = `api/councils/${encodeURIComponent(id)}`
  const draftKey = `sa-council-brief-${id}`

  root.innerHTML = `<div class="head"><a class="btn btn--quiet cv-back" href="#/tickets">${icons.back} 任务</a>
    <p class="hint" style="margin-top:14px">正在读这场会商…</p></div>`

  function syncAnswers(brief) {
    const questions = parseBrief(brief).questions
    const next = {}
    questions.forEach((question, index) => {
      const key = String(index)
      const previous = state.answers[key]
      next[key] = previous && previous.text === question.text
        ? previous
        : { text: question.text, default: question.default, mode: 'default', value: '' }
    })
    state.questions = questions
    state.answers = next
  }

  function confirmationAnswers() {
    return state.questions
      .map((question, index) => {
        const answer = state.answers[String(index)]
        const custom = answer?.mode === 'custom' ? String(answer.value ?? '').trim() : ''
        return { text: question.text, answer: custom || question.default }
      })
      .filter((entry) => entry.answer)
  }

  function stopTimer() {
    if (timer) window.clearInterval(timer)
    timer = null
  }

  function ensureTimer() {
    // An auto-start council keeps polling after `done` until its ticket is attached (or the start failed).
    const waitingStart = state.data?.status === 'done' && state.data?.autoStart && !state.data?.ticketId && !state.data?.error
    const should = alive && !state.busy && !state.editing
      && (state.data?.status === 'running' || waitingStart) && !document.hidden
    if (should && !timer) timer = window.setInterval(() => { load().catch(() => {}) }, 1500)
    if (!should) stopTimer()
  }

  async function load() {
    if (!alive || state.busy) return
    const snap = keep.snapshot(root)
    const tasks = [get(api)]
    if (!state.modelsLoaded) {
      state.modelsLoaded = true
      tasks.push(get('api/models').then((result) => {
        state.models = Array.isArray(result?.items) ? result.items : []
      }).catch(() => { state.models = [] }))
    }
    let data
    try {
      ;[data] = await Promise.all(tasks)
    } catch (error) {
      if (!alive) return
      if (error?.status === 404) {
        state.notFound = true
        state.data = null
        paintNotFound()
        return
      }
      if (error?.status === 401) return
      state.loadError = error?.message || '请求失败'
      if (!state.data) {
        root.innerHTML = `<div class="head"><a class="btn btn--quiet cv-back" href="#/tickets">${icons.back} 任务</a></div>
          <div class="banner"><span>这场会商没读出来：${esc(state.loadError)}</span>
          <button class="btn btn--quiet" type="button" data-action="reload" style="margin-left:auto;color:inherit">重试</button></div>`
      }
      return
    }
    if (!alive) return
    state.loadError = ''
    state.notFound = false
    state.data = data
    if (data.brief && state.briefSource !== data.brief) {
      state.briefSource = data.brief
      if (!state.editing) {
        state.draft = ''
        try { sessionStorage.removeItem(draftKey) } catch { /* private mode */ }
      }
      syncAnswers(data.brief)
    }
    paint(data)
    loadProjectName(data.projectId)
    keep.restore(root, snap)
    ensureTimer()
  }

  function paintNotFound() {
    stopTimer()
    root.innerHTML = `<div class="head"><a class="btn btn--quiet cv-back" href="#/tickets">${icons.back} 任务</a></div>
      ${emptyHtml('这场会商不存在了', '可能已经被丢弃，或者链接不对。会商记录只保存在这台机器上。', '回任务', '#/tickets')}`
  }

  function topicPreview(topic) {
    const chars = [...String(topic ?? '')]
    return chars.length > 80 ? `${chars.slice(0, 80).join('')}…` : chars.join('')
  }

  function taskbookHtml(data) {
    if (data.mode !== 'brief') return ''
    if (!data.brief) {
      if (data.status === 'running') {
        return `<section class="cv-brief cv-brief--wait"><h2 class="cv-h2">任务书</h2>
          <p class="hint">主持人还在汇总。各角色的发言都结束后，这里会出现任务书。${data.autoStart ? '任务书出来后会自动开工，任务会出现在任务列表里。' : ''}</p></section>`
      }
      return ''
    }
    const submitted = Boolean(data.ticketId)
    const total = Array.isArray(data.rounds) ? data.rounds.length : 1
    const canNext = total < 3
    const text = state.editing ? state.draft : state.briefSource
    const length = String(text ?? '').length
    return `<details class="cv-brief" data-keep="council.brief" open>
      <summary class="cv-brief__summary">
        <span class="cv-h2">任务书</span>
        <span class="cv-count">${length} 字</span>
      </summary>
      <div class="cv-brief__body">
        ${submitted ? `<p class="cv-submitted">已开工，<a href="#/tickets/${encodeURIComponent(data.ticketId)}">去看任务</a></p>` : ''}
        ${!submitted && data.status === 'done' && data.error ? `<p class="cv-error" role="alert">${esc(data.error)}</p>` : ''}
        ${!submitted && data.status === 'done' && data.autoStart && !data.error ? '<p class="hint">正在按任务书开工…</p>' : ''}
        ${state.editing
          ? `<label class="field" for="cv-brief-edit"><span class="field__label">可以直接改。改完点「保存并开工」，原始的会商记录不会变。</span>
              <textarea class="textarea cv-brief__edit" id="cv-brief-edit" rows="12" data-brief-edit data-focus-key="council.brief">${esc(state.draft)}</textarea></label>
            <div class="cv-actions">
              <button class="btn btn--ink" type="button" data-action="commit-edit" ${state.busy ? 'disabled' : ''}>保存并开工</button>
              <button class="btn" type="button" data-action="edit-cancel">不改了</button>
            </div>`
          : briefHtml(state.briefSource)}
        ${!submitted && !state.editing ? questionsHtml() : ''}
        ${!submitted && !state.editing ? `<div class="cv-actions">
          <button class="btn btn--ink" type="button" data-action="commit-direct" ${state.busy ? 'disabled' : ''}>直接开工</button>
          <button class="btn" type="button" data-action="edit">编辑后开工</button>
          <button class="btn btn--quiet" type="button" data-action="copy-brief">复制任务书</button>
          <button class="btn btn--quiet" type="button" data-action="next-round" ${canNext ? '' : 'disabled'} title="${canNext ? '' : '最多 3 轮'}">再来一轮</button>
          <button class="btn btn--danger" type="button" data-action="discard">丢弃</button>
        </div>
        <p class="hint">开工后会开一张新任务；这场会商的记录会留在任务页。${canNext ? '' : '已经到 3 轮上限，不能再加了。'}</p>` : ''}
        ${submitted ? `<div class="cv-actions">
          <button class="btn btn--quiet" type="button" data-action="next-round" ${canNext ? '' : 'disabled'}>再来一轮</button>
        </div>` : ''}
        <details class="cv-more" data-keep="council.more">
          <summary>更多选项</summary>
          <div class="cv-more__body">
            <label class="field" for="cv-model"><span class="field__label">开工后用哪个模型</span>
              <select class="select" id="cv-model" data-model>
                <option value="">让它挑</option>
                ${state.models.filter((item) => item.enabled !== false).map((item) => `<option value="${esc(item.ref)}"${state.model === item.ref ? ' selected' : ''}>${esc(item.label || item.model)}${item.providerName ? ` · ${esc(item.providerName)}` : ''}</option>`).join('')}
              </select>
            </label>
            <p class="hint">会商本身用后台配置的模型；这里只影响开工后的执行模型。</p>
          </div>
        </details>
        ${state.error ? `<p class="cv-error" role="alert">${esc(state.error)}</p>` : ''}
      </div>
    </details>`
  }

  function questionsHtml() {
    if (!state.questions.length) return ''
    return `<section class="cv-questions">
      <h3 class="cv-h3">开工前确认</h3>
      <p class="hint">每一条都有默认答案。可以逐条采用默认，或者自己改写。</p>
      ${state.questions.map((question, index) => {
        const answer = state.answers[String(index)] ?? { mode: 'default', value: '' }
        const custom = answer.mode === 'custom'
        return `<div class="cv-q" data-q="${index}">
          <p class="cv-q__text">${esc(question.text)}</p>
          ${question.default ? `<p class="cv-q__default">默认：${esc(question.default)}</p>` : '<p class="cv-q__default">没有写默认答案。</p>'}
          <div class="cv-q__choices" role="group" aria-label="第 ${index + 1} 条的答案">
            <button class="cv-choice" type="button" data-action="answer-mode" data-q="${index}" data-mode="default" data-answer-mode="default" aria-pressed="${!custom}">采用默认</button>
            <button class="cv-choice" type="button" data-action="answer-mode" data-q="${index}" data-mode="custom" data-answer-mode="custom" aria-pressed="${custom}">改写</button>
            <input class="input cv-q__input" type="text" data-answer-input data-q="${index}"
              value="${esc(answer.value)}" placeholder="写你的答案" aria-label="第 ${index + 1} 条的答案"${custom ? '' : ' hidden'}>
          </div>
        </div>`
      }).join('')}
    </section>`
  }

  function paint(data) {
    const roundCount = Array.isArray(data.rounds) ? data.rounds.length : 0
    const failed = data.status === 'failed'
    const cancelled = data.status === 'cancelled'
    const running = data.status === 'running'
    const decision = data.mode === 'decision'
    const advice = decision && data.brief ? decisionParts(data.brief).advice : ''
    root.innerHTML = `
      <div class="head cv-head">
        <div class="cv-crumbs"><a class="btn btn--quiet cv-back" href="#/tickets">${icons.back} 任务</a>
          <span class="cv-mode">${esc(modeWord(data.mode))}</span>
          ${data.projectId ? `<a class="cv-badge" href="#/projects/${encodeURIComponent(data.projectId)}" data-project-badge>${esc(projectNames.get(data.projectId) || '关联项目')}</a>` : ''}
        </div>
        <h1 class="cv-title">${decision ? '决策会商' : '会商纪要'}</h1>
        <details class="cv-topic" data-keep="council.topic">
          <summary><span class="cv-topic__label">话题</span><span class="cv-topic__preview">${esc(topicPreview(data.topic))}</span></summary>
          <p class="cv-topic__full">${esc(data.topic)}</p>
        </details>
        <div class="cv-status" data-s="${esc(data.status)}">
          <span class="cv-status__word"><span class="cv-mark" aria-hidden="true"></span>${esc(statusWord(data.status))}</span>
          <span class="cv-status__item">${esc(roundProgress(data))}</span>
          <span class="cv-status__item">已花 ${money4(data.costUsd ?? 0)}</span>
          ${running ? '<button class="btn btn--quiet cv-cancel" type="button" data-action="cancel">取消会商</button>' : ''}
        </div>
        ${failed ? `<p class="cv-error" role="alert">${esc(data.error || '这次会商没能完成。')}</p>` : ''}
        ${cancelled ? '<p class="hint">这场会商已经取消；已经发出的调用不会退款，已有的发言仍然保留。</p>' : ''}
      </div>

      <section class="cv-minutes">
        <div class="cv-section-head"><h2 class="cv-h2">纪要</h2><span class="cv-count">${roundCount} 轮</span></div>
        ${roundsHtml(data.rounds)}
        ${hostNoteHtml(data)}
        ${running && !roundCount ? '<p class="hint">会商刚开始，各角色还没开口。</p>' : ''}
      </section>

      ${taskbookHtml(data)}

      ${failed ? `<div class="cv-actions cv-fail-actions">
        <button class="btn btn--ink" type="button" data-action="retry" ${state.busy ? 'disabled' : ''}>重试</button>
        <button class="btn btn--danger" type="button" data-action="discard">丢弃</button>
      </div>` : ''}

      ${decision && data.brief ? `<section class="cv-decision-actions">
        <div class="cv-actions">
          <button class="btn btn--human" type="button" data-action="adopt" ${data.ticketId ? '' : 'disabled'} title="${data.ticketId ? '' : '这场会商没有关联任务'}">采纳并回复</button>
          ${data.ticketId ? `<a class="btn" href="#/tickets/${encodeURIComponent(data.ticketId)}">去看任务</a>` : ''}
          <button class="btn btn--quiet" type="button" data-action="copy-decision">复制建议</button>
          <button class="btn btn--danger" type="button" data-action="discard">丢弃</button>
        </div>
        ${data.ticketId ? '<p class="hint">采纳后会打开任务页，把「建议」这段填进回复框；你确认后再送出去。</p>' : '<p class="hint">这场会商没有关联任务，不能采纳。</p>'}
      </section>` : ''}

      ${cancelled ? `<div class="cv-actions cv-fail-actions">
        <button class="btn btn--danger" type="button" data-action="discard">丢弃</button>
      </div>` : ''}
    `
  }

  async function withBusy(run) {
    if (state.busy) return
    state.busy = true
    state.error = ''
    if (state.data) paint(state.data)
    try {
      await run()
    } catch (error) {
      state.error = error?.message || '操作没有成功'
      bus.toast(state.error, { danger: true })
    } finally {
      state.busy = false
      if (alive && state.data) {
        paint(state.data)
        ensureTimer()
      }
    }
  }

  async function commit(source) {
    const text = String(source ?? '')
    if (!text.trim()) {
      state.error = '任务书不能是空的。'
      paint(state.data)
      return
    }
    if (text.length > 10000) {
      state.error = '任务书太长，请精简到 10000 字以内'
      paint(state.data)
      return
    }
    const brief = appendConfirmations(text, confirmationAnswers())
    await withBusy(async () => {
      const result = await post(`${api}/commit`, {
        brief,
        ...(state.model ? { model: state.model } : {}),
      })
      try { sessionStorage.removeItem(draftKey) } catch { /* private mode */ }
      state.editing = false
      state.draft = ''
      bus.toast('已开工')
      invalidateOverview()
      bus.refreshOverview?.()
      const ticketId = result?.ticketId
      if (ticketId) ctx.navigate(`tickets/${encodeURIComponent(ticketId)}`)
      else ctx.navigate('tickets')
    })
  }

  async function retry() {
    const data = state.data
    await withBusy(async () => {
      const result = await post('api/councils', {
        mode: data.mode,
        text: data.topic,
        ...(data.projectId ? { projectId: data.projectId } : {}),
        ...(data.ticketId ? { ticketId: data.ticketId } : {}),
        rounds: Array.isArray(data.rounds) ? data.rounds.length : 2,
      })
      if (result?.id) ctx.navigate(`council/${encodeURIComponent(result.id)}`)
    })
  }

  async function nextRound() {
    const data = state.data
    const total = Array.isArray(data.rounds) ? data.rounds.length : 1
    if (total >= 3) {
      bus.toast('最多 3 轮，已经到顶了。', { danger: true })
      return
    }
    await withBusy(async () => {
      const result = await post('api/councils', {
        mode: data.mode,
        text: data.topic,
        ...(data.projectId ? { projectId: data.projectId } : {}),
        rounds: total + 1,
      })
      if (result?.id) ctx.navigate(`council/${encodeURIComponent(result.id)}`)
    })
  }

  async function discard() {
    const values = await bus.sheet({
      title: '丢弃这场会商？',
      text: '会删除会商记录和全部发言。已经开出的任务不受影响。',
      confirmLabel: '丢弃',
      danger: true,
    })
    if (!values) return
    await withBusy(async () => {
      await del(api)
      bus.toast('已丢弃')
      invalidateOverview()
      ctx.navigate('tickets')
    })
  }

  async function cancel() {
    const values = await bus.sheet({
      title: '取消这场会商？',
      text: '已经在跑的模型调用会继续走完，已经发出的调用不会退款；留下来的发言仍然可以看。',
      confirmLabel: '取消会商',
      danger: true,
    })
    if (!values) return
    state.busy = true
    stopTimer()
    if (state.data) paint(state.data)
    try {
      await post(`${api}/cancel`, {})
      state.busy = false
      bus.toast('已取消')
      await load()
    } catch (error) {
      state.busy = false
      state.error = error?.message || '取消没有成功'
      if (state.data) paint(state.data)
      ensureTimer()
    }
  }

  async function adopt() {
    const data = state.data
    const advice = decisionParts(data.brief).advice
    if (!data.ticketId) return
    try { sessionStorage.setItem(`sa-ticket-reply-${data.ticketId}`, advice) } catch { /* private mode */ }
    ctx.navigate(`tickets/${encodeURIComponent(data.ticketId)}`)
  }

  async function startEdit() {
    state.editing = true
    state.error = ''
    let saved = ''
    try { saved = sessionStorage.getItem(draftKey) ?? '' } catch { /* private mode */ }
    state.draft = saved || state.briefSource
    paint(state.data)
    const field = root.querySelector('[data-brief-edit]')
    if (field) {
      field.focus({ preventScroll: true })
      field.setSelectionRange(field.value.length, field.value.length)
    }
  }

  async function saveAndCommit() {
    const field = root.querySelector('[data-brief-edit]')
    const text = field ? field.value : state.draft
    if (String(text).length > 10000) {
      state.error = '任务书太长，请精简到 10000 字以内'
      state.draft = text
      paint(state.data)
      return
    }
    state.draft = text
    state.briefSource = text
    syncAnswers(text)
    state.editing = true
    paint(state.data)
    await commit(text)
  }

  root.addEventListener('click', async (event) => {
    const action = event.target.closest('[data-action]')?.dataset.action
    if (!action) {
      const modeButton = event.target.closest('[data-answer-mode]')
      if (!modeButton) return
      return
    }
    if (action === 'reload') { await load(); return }
    if (action === 'cancel') { await cancel(); return }
    if (action === 'discard') { await discard(); return }
    if (action === 'retry') { await retry(); return }
    if (action === 'next-round') { await nextRound(); return }
    if (action === 'commit-direct') { await commit(state.briefSource); return }
    if (action === 'edit') { await startEdit(); return }
    if (action === 'edit-cancel') {
      state.editing = false
      state.draft = ''
      state.error = ''
      try { sessionStorage.removeItem(draftKey) } catch { /* private mode */ }
      paint(state.data)
      return
    }
    if (action === 'commit-edit') { await saveAndCommit(); return }
    if (action === 'copy-brief') { await copyText(state.briefSource, '任务书已复制'); return }
    if (action === 'copy-decision') {
      await copyText(decisionParts(state.data.brief).advice, '建议已复制')
      return
    }
    if (action === 'adopt') { await adopt(); return }
    if (action === 'answer-mode') {
      const key = String(event.target.dataset.q)
      const mode = event.target.dataset.mode === 'custom' ? 'custom' : 'default'
      const answer = state.answers[key]
      if (!answer) return
      answer.mode = mode
      const block = event.target.closest('.cv-q')
      block?.querySelectorAll('[data-answer-mode]').forEach((button) => {
        button.setAttribute('aria-pressed', String(button.dataset.mode === mode))
      })
      const input = block?.querySelector('[data-answer-input]')
      if (input) {
        input.hidden = mode !== 'custom'
        if (mode === 'custom') input.focus({ preventScroll: true })
      }
    }
  })

  root.addEventListener('input', (event) => {
    const briefField = event.target.closest('[data-brief-edit]')
    if (briefField) {
      state.draft = briefField.value
      try { sessionStorage.setItem(draftKey, briefField.value) } catch { /* private mode */ }
      return
    }
    const answerField = event.target.closest('[data-answer-input]')
    if (answerField) {
      const key = String(answerField.dataset.q)
      if (state.answers[key]) state.answers[key].value = answerField.value
    }
  })

  root.addEventListener('change', (event) => {
    const model = event.target.closest('[data-model]')
    if (model) state.model = model.value
  })

  const onVisibility = () => {
    if (document.hidden) {
      stopTimer()
      return
    }
    if (state.data?.status === 'running') load().catch(() => {})
    ensureTimer()
  }
  document.addEventListener('visibilitychange', onVisibility)

  load().catch(() => {})

  return {
    root,
    refresh: async () => {
      if (state.editing || state.busy) return
      await load()
    },
    destroy() {
      alive = false
      stopTimer()
      document.removeEventListener('visibilitychange', onVisibility)
    },
  }
}
