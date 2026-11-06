/**
 * 发任务. One form, two hosts: the full page (`mount`, kept for compatibility)
 * and the dialog panel (`mountPanel`) opened by the shell's ＋ button.
 * Both share the same fields, submit path and localStorage draft.
 *
 * The "附加" row attaches a project (an existing ready one, or an archive
 * uploaded on the spot), and optionally asks for a council first. An upload that
 * is still running keeps running when the panel closes; sending then waits for
 * the project to become ready and starts the work automatically.
 */
import { get, post, invalidateOverview } from '../lib/api.js'
import { bus } from '../lib/bus.js'
import { esc } from '../lib/view.js'
import { bytes, duration } from '../lib/format.js'
import * as upload from '../lib/upload.js'

const DRAFT_KEY = 'sa-draft'
const MIB = 1024 * 1024

function readDraft() {
  try {
    const raw = localStorage.getItem(DRAFT_KEY)
    const value = raw ? JSON.parse(raw) : null
    if (!value || typeof value !== 'object') return {}
    return {
      text: typeof value.text === 'string' ? value.text : '',
      model: typeof value.model === 'string' ? value.model : '',
      secrets: Array.isArray(value.secrets) ? value.secrets.map(String) : [],
      projectId: typeof value.projectId === 'string' ? value.projectId : '',
      council: value.council === true,
      councilSet: typeof value.council === 'boolean',
    }
  } catch {
    return {}
  }
}

function clearDraft() {
  try { localStorage.removeItem(DRAFT_KEY) } catch { /* a private window may refuse */ }
}

function speedText(value) {
  const speed = Number(value)
  if (!Number.isFinite(speed) || speed <= 0) return '正在估算'
  return `${bytes(speed)}/秒`
}

function etaText(value) {
  const seconds = Number(value)
  if (!Number.isFinite(seconds) || seconds <= 0) return '正在估算剩余时间'
  return `剩余约 ${duration(seconds)}`
}

function uploadPercent(state) {
  const pct = Math.max(0, Math.min(100, Number(state.percent) || 0))
  return Math.round(pct)
}

/**
 * Shared form. `panel` trims the page chrome; everything else is identical.
 */
function createCompose(ctx, { preset = {}, panel = false } = {}) {
  const root = document.createElement('div')
  root.className = panel ? 'compose-form' : 'page'
  let alive = true
  let models = { items: [], default: '', autoSelect: true }
  let recent = []
  let secretItems = []
  let projectItems = []
  let projectsLoaded = false
  let projectSettings = { maxUploadMb: 4096 }
  let councilSettings = { enabled: false, defaultOn: false }
  let councilAvailable = false
  let submitting = false
  let sent = false
  let draftTimer = null
  let pickerOpen = false
  let secretsOpen = false
  let uploadState = upload.state()
  let unsubscribeUpload = null
  let waiting = null
  let lastDoneProject = ''

  const draft = { ...readDraft(), ...preset }
  const state = {
    text: typeof draft.text === 'string' ? draft.text : '',
    model: typeof draft.model === 'string' ? draft.model : '',
    secrets: Array.isArray(draft.secrets) ? draft.secrets.map(String) : [],
    projectId: typeof draft.projectId === 'string' ? draft.projectId : '',
    council: draft.council === true,
    councilSet: draft.councilSet === true,
  }

  const saveDraft = () => {
    if (sent) return
    try {
      localStorage.setItem(DRAFT_KEY, JSON.stringify({
        text: state.text,
        model: state.model,
        secrets: state.secrets,
        projectId: state.projectId,
        council: state.council,
      }))
    } catch { /* storage may be unavailable; the in-memory form still works */ }
  }
  const scheduleSave = () => {
    if (sent) return
    if (draftTimer) clearTimeout(draftTimer)
    draftTimer = setTimeout(saveDraft, 300)
  }

  const projectOf = (id) => projectItems.find((item) => item.id === id) || null

  const uploadActive = () => uploadState.active === true

  const waitsForUpload = () => uploadActive() && (!state.projectId || state.projectId === uploadState.projectId)

  const willWait = () => {
    if (waitsForUpload()) return true
    if (state.projectId) {
      const project = projectOf(state.projectId)
      if (project && project.status !== 'ready') return true
      if (!projectsLoaded) return false
    }
    return false
  }

  const projectLabel = () => {
    if (state.projectId) {
      const project = projectOf(state.projectId)
      if (project) return `${project.name}，${bytes(project.bytes ?? 0)}`
      if (!projectsLoaded) return state.projectId
      return '所选项目已不可用'
    }
    if (uploadActive()) return uploadState.name || '正在上传'
    if (uploadState.phase === 'done' && uploadState.projectId) {
      const project = projectOf(uploadState.projectId)
      return project ? `${project.name}，${bytes(project.bytes ?? 0)}` : uploadState.name
    }
    return '未选'
  }

  const render = async () => {
    const results = await Promise.allSettled([
      get('api/models'),
      get('api/tickets', { status: 'all', limit: 3 }),
      get('api/secrets'),
      get('api/projects'),
      get('api/settings/projects'),
      get('api/settings/council'),
    ])
    if (!alive) return
    const [modelResult, ticketResult, secretResult, projectResult, projectSettingsResult, councilResult] = results
    if (modelResult.status === 'fulfilled') models = modelResult.value ?? models
    if (ticketResult.status === 'fulfilled') recent = Array.isArray(ticketResult.value?.items) ? ticketResult.value.items : []
    if (secretResult.status === 'fulfilled') secretItems = Array.isArray(secretResult.value?.items) ? secretResult.value.items : []
    if (projectResult.status === 'fulfilled') {
      projectItems = Array.isArray(projectResult.value?.items) ? projectResult.value.items : []
      projectsLoaded = true
    }
    if (projectSettingsResult.status === 'fulfilled' && Number(projectSettingsResult.value?.maxUploadMb) > 0) {
      projectSettings = projectSettingsResult.value
    }
    if (councilResult.status === 'fulfilled' && councilResult.value?.enabled !== false) {
      councilSettings = {
        enabled: true,
        defaultOn: councilResult.value?.defaultOn === true,
      }
      councilAvailable = true
      if (!state.councilSet) state.council = councilSettings.defaultOn
    } else {
      councilAvailable = false
      state.council = false
    }
    paint()
    paintProjects()
    paintAttach()
    paintPicker()
    paintUploadCard()
    paintWaiting()
  }

  function paint() {
    const options = Array.isArray(models.items) ? models.items : []
    const auto = models.autoSelect !== false
    root.innerHTML = `
      ${panel ? '' : `<div class="head">
        <div class="head__row"><h1 class="head__title">发新任务</h1></div>
        <p class="head__sub">说清楚要什么就行；可以附上一个项目，也可以先让几位角色会商一下</p>
      </div>`}
      <div class="field">
        <label class="field__label" for="ask-text">要它做什么</label>
        <textarea class="textarea" rows="5" id="ask-text" data-text data-focus-key="compose.text" placeholder="例如：对着这个项目，把登录流程改成支持邮箱验证码，并补上测试"></textarea>
      </div>
      <div class="attach" data-attach>
        <button class="attach__btn" type="button" data-project-toggle aria-expanded="false">
          <span class="attach__kind">项目</span>
          <span class="attach__value" data-project-label>未选</span>
        </button>
        ${councilAvailable ? `<button class="attach__btn attach__switch" type="button" role="switch" aria-checked="${state.council ? 'true' : 'false'}" data-council>
          <span class="attach__kind">先会商</span>
          <span class="attach__value" data-council-label>${state.council ? '开' : '关'}</span>
        </button>` : ''}
        ${options.length ? `<label class="attach__field">
          <span class="attach__kind">模型</span>
          <select class="select attach__select" data-model aria-label="执行模型">
            <option value="">${auto ? '让它挑' : `默认${models.default ? `（${esc(models.default)}）` : ''}`}</option>
            ${options.map((item) => `<option value="${esc(item.ref)}">${esc(item.label)}${item.providerName ? `（${esc(item.providerName)}）` : ''}</option>`).join('')}
          </select>
        </label>` : ''}
        ${secretItems.length ? `<button class="attach__btn" type="button" data-secrets-toggle aria-expanded="false">
          <span class="attach__kind">密钥</span>
          <span class="attach__value" data-secrets-label>可选</span>
        </button>` : ''}
      </div>
      <div class="project-picker" data-project-picker hidden>
        <div class="project-picker__head">
          <span class="project-picker__title">选一个可用的项目</span>
          <button class="btn btn--quiet" type="button" data-picker-close>收起</button>
        </div>
        <div class="project-picker__list" data-picker-list></div>
        <button class="project-picker__upload" type="button" data-pick-upload>上传新项目…</button>
      </div>
      <div class="secret-picker" data-secret-picker hidden>
        ${secretItems.map((secret) => `<label class="checkline">
          <input type="checkbox" data-secret value="${esc(secret.name)}">
          <span><span class="mono">${esc(secret.name)}</span>${secret.description ? `<span class="hint">，${esc(secret.description)}</span>` : ''}</span>
        </label>`).join('')}
      </div>
      <input type="file" hidden accept=".zip,application/zip" data-file-input>
      <div data-upload-card></div>
      <div data-waiting></div>
      <div class="strip">
        <div class="num"><div class="num__k">单票预算</div><div class="num__v" data-budget>—</div></div>
        <div class="num"><div class="num__k">并发</div><div class="num__v" data-slots>—</div></div>
        <div class="num"><div class="num__k">今日已花</div><div class="num__v" data-spent>—</div></div>
      </div>
      ${!panel && recent.length ? `<section class="section">
        <div class="section__head"><h2 class="section__title">最近发过的</h2></div>
        <div class="list">
          ${recent.map((ticket) => `<a class="row row--link" href="#/tickets/${encodeURIComponent(ticket.id)}">
            <span class="row__main"><span class="row__title">${esc(ticket.title)}</span>
            <span class="row__meta"><span>${esc(ticket.stageLabel || '')}</span></span></span>
            <span class="row__side">›</span></a>`).join('')}
        </div>
      </section>` : ''}
      <div class="stickybar">
        <button class="btn btn--ink btn--wide" type="button" data-send>发送，开一张工单</button>
      </div>`

    const textarea = root.querySelector('[data-text]')
    if (textarea) {
      textarea.value = state.text
      autoGrow(textarea)
    }
    const select = root.querySelector('[data-model]')
    if (select) select.value = state.model
    for (const input of root.querySelectorAll('[data-secret]')) {
      input.checked = state.secrets.includes(input.value)
    }
    const secretPicker = root.querySelector('[data-secret-picker]')
    if (secretPicker) secretPicker.hidden = !secretsOpen
    paintStats()
    paintSend()
    paintProjects()
    paintAttach()
    paintPicker()
    paintUploadCard()
    paintWaiting()
    const hint = root.querySelector('[data-secrets-label]')
    if (hint) hint.textContent = state.secrets.length ? `已选 ${state.secrets.length} 个` : '可选'
    requestAnimationFrame(() => {
      if (textarea && document.activeElement !== textarea) textarea.focus({ preventScroll: true })
    })
  }

  function paintStats() {
    const overview = ctx.overview?.()
    const budget = overview?.usage
    const slots = root.querySelector('[data-slots]')
    const spent = root.querySelector('[data-spent]')
    if (slots) slots.textContent = overview ? `${overview.slots?.max ?? '—'} 个` : '—'
    if (spent) spent.textContent = budget ? `$${Number(budget.todayUsd ?? 0).toFixed(2)}` : '—'
    const budgetNode = root.querySelector('[data-budget]')
    if (budgetNode) {
      budgetNode.textContent = budget?.dailyBudgetUsd > 0
        ? `日上限 $${Number(budget.dailyBudgetUsd).toFixed(2)}`
        : '未设上限'
    }
  }

  function paintAttach() {
    const label = root.querySelector('[data-project-label]')
    if (label) label.textContent = projectLabel()
    const toggle = root.querySelector('[data-project-toggle]')
    if (toggle) toggle.setAttribute('aria-expanded', pickerOpen ? 'true' : 'false')
    const council = root.querySelector('[data-council]')
    if (council) {
      council.setAttribute('aria-checked', state.council ? 'true' : 'false')
      const text = council.querySelector('[data-council-label]')
      if (text) text.textContent = state.council ? '开' : '关'
    }
    const secretsToggle = root.querySelector('[data-secrets-toggle]')
    if (secretsToggle) secretsToggle.setAttribute('aria-expanded', secretsOpen ? 'true' : 'false')
    const secretsLabel = root.querySelector('[data-secrets-label]')
    if (secretsLabel) secretsLabel.textContent = state.secrets.length ? `已选 ${state.secrets.length} 个` : '可选'
    paintSend()
  }

  function paintProjects() {
    const host = root.querySelector('[data-picker-list]')
    if (!host) return
    const ready = projectItems.filter((item) => item.status === 'ready')
    if (!projectsLoaded) {
      host.innerHTML = '<p class="hint">正在读项目…</p>'
      return
    }
    if (!ready.length) {
      host.innerHTML = '<p class="hint">还没有可用的项目。上传一个压缩包就能用它开工。</p>'
      return
    }
    host.innerHTML = ready.map((item) => `<button class="pickrow${item.id === state.projectId ? ' pickrow--picked' : ''}" type="button" data-pick-project="${esc(item.id)}">
      <span class="pickrow__main">
        <span class="pickrow__name">${esc(item.name)}</span>
        <span class="pickrow__meta">${Number(item.files ?? 0).toLocaleString('en-US')} 个文件，${bytes(item.bytes ?? 0)}</span>
      </span>
      <span class="pickrow__side">${item.id === state.projectId ? '已选' : '选它'}</span>
    </button>`).join('')
  }

  function paintPicker() {
    const picker = root.querySelector('[data-project-picker]')
    if (picker) picker.hidden = !pickerOpen
  }

  function paintSend() {
    const button = root.querySelector('[data-send]')
    if (!button) return
    if (waiting) {
      button.textContent = '等待项目就绪…'
      button.disabled = true
    } else if (willWait()) {
      button.textContent = '发送（项目就绪后自动开工）'
      button.disabled = submitting
    } else {
      button.textContent = state.council ? '发送，先开一次会商' : '发送，开一张工单'
      button.disabled = submitting
    }
  }

  function paintUploadCard() {
    const host = root.querySelector('[data-upload-card]')
    if (!host) return
    const current = uploadState
    if (!current || current.phase === 'idle') {
      host.innerHTML = ''
      return
    }
    const pct = uploadPercent(current)
    const bar = `<div class="upbar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}"><i style="width:${pct}%"></i></div>`
    if (current.phase === 'done') {
      const link = current.projectId ? `<a class="btn btn--quiet" href="#/projects/${encodeURIComponent(current.projectId)}">查看项目</a>` : ''
      host.innerHTML = `<div class="upcard upcard--done">
        <div class="upcard__head"><span class="upcard__name">${esc(current.name || '压缩包')}</span><span class="pstat upcard__state" data-s="ready"><i class="pstat__mark" aria-hidden="true"></i>项目已上传</span></div>
        ${bar}
        <div class="upcard__foot"><span>${bytes(current.size ?? 0)}</span>${link}</div>
      </div>`
      return
    }
    if (current.phase === 'failed') {
      host.innerHTML = `<div class="upcard upcard--failed">
        <div class="upcard__head"><span class="upcard__name">${esc(current.name || '压缩包')}</span><span class="pstat upcard__state" data-s="failed"><i class="pstat__mark" aria-hidden="true"></i>上传失败</span></div>
        <p class="upcard__error">${esc(current.error || '上传没有成功。')}</p>
        <div class="upcard__actions">
          <button class="btn btn--quiet" type="button" data-upload-pick>重新选择文件</button>
          ${upload.pending() ? '<a class="btn btn--quiet" href="#/projects">去项目页继续上次的上传</a>' : ''}
          <button class="btn btn--quiet" type="button" data-upload-dismiss>收起</button>
        </div>
      </div>`
      return
    }
    if (current.phase === 'extracting' || current.phase === 'finishing') {
      const extract = current.phase === 'finishing'
        ? '正在收尾'
        : current.extractTotal > 0
          ? `正在解压 ${Number(current.extractDone).toLocaleString('en-US')} / ${Number(current.extractTotal).toLocaleString('en-US')}`
          : '正在解压'
      host.innerHTML = `<div class="upcard">
        <div class="upcard__head"><span class="upcard__name">${esc(current.name || '压缩包')}</span><span class="pstat upcard__state" data-s="extracting"><i class="pstat__mark" aria-hidden="true"></i>${esc(extract)}</span></div>
        ${bar}
        <div class="upcard__foot"><span>${current.phase === 'finishing' ? '上传完了，正在交给解压' : '解压完就能开任务'}</span>
        ${current.projectId ? `<a class="btn btn--quiet" href="#/projects/${encodeURIComponent(current.projectId)}">看项目</a>` : ''}</div>
      </div>`
      return
    }
    const paused = current.phase === 'paused'
    host.innerHTML = `<div class="upcard">
      <div class="upcard__head"><span class="upcard__name">${esc(current.name || '压缩包')}</span><span class="pstat upcard__state" data-s="${paused ? 'paused' : 'uploading'}"><i class="pstat__mark" aria-hidden="true"></i>${paused ? '已暂停' : '正在上传'}</span></div>
      ${bar}
      <div class="upcard__meta">
        <span>${bytes(current.sent ?? 0)} / ${bytes(current.size ?? 0)}</span>
        <span>${speedText(current.speedBps)}</span>
        ${Number(current.etaSec) > 0 ? `<span>${etaText(current.etaSec)}</span>` : ''}
      </div>
      ${current.notice ? `<p class="upcard__notice">${esc(current.notice)}</p>` : ''}
      <div class="upcard__actions">
        ${paused
          ? '<button class="btn btn--ink" type="button" data-upload-resume>继续</button>'
          : '<button class="btn" type="button" data-upload-pause>暂停</button>'}
        <button class="btn btn--danger" type="button" data-upload-cancel>取消</button>
      </div>
    </div>`
  }

  function paintWaiting() {
    const host = root.querySelector('[data-waiting]')
    if (!host) return
    if (!waiting) {
      host.innerHTML = ''
      return
    }
    host.innerHTML = `<p class="waitline">
      <span>项目还没就绪；好了会自动开工。</span>
      <span class="hint">刷新页面会取消自动开工，草稿会保留。</span>
      <button class="btn btn--quiet" type="button" data-wait-cancel>取消等待</button>
    </p>`
  }

  function autoGrow(textarea) {
    if (!textarea) return
    textarea.style.height = 'auto'
    textarea.style.height = `${Math.min(Math.max(textarea.scrollHeight, 132), 360)}px`
  }

  function notify(message) {
    bus.toast(message, { danger: true })
  }

  function pickFile(file) {
    if (!file) return
    const name = String(file.name || '')
    if (!/\.zip$/i.test(name)) {
      notify('只收 .zip 压缩包。先把它打成 zip 再上传。')
      return
    }
    const maxMb = Number(projectSettings.maxUploadMb) > 0 ? Number(projectSettings.maxUploadMb) : 4096
    if (file.size > maxMb * MIB) {
      notify(`这个压缩包有 ${bytes(file.size)}，超过了 ${maxMb} MB 的上传上限，可在设置→项目里调高。`)
      return
    }
    if (upload.state().active) {
      notify('已经有一个项目在上传了，等它传完再选。')
      return
    }
    pickerOpen = false
    paintPicker()
    state.projectId = ''
    saveDraft()
    paintAttach()
    upload.start(file, {}).catch((error) => {
      notify(error?.message || '上传没有开始。')
    })
  }

  function selectedProjectReady() {
    if (!state.projectId) return false
    const project = projectOf(state.projectId)
    return Boolean(project && project.status === 'ready')
  }

  async function submit(text, projectId, { council = state.council, model = state.model, secrets = state.secrets } = {}) {
    if (council) {
      const result = await post('api/councils', {
        mode: 'brief',
        text,
        // 发任务 + 会商 means "discuss, then do it": the task opens by itself once the task book is ready.
        autoStart: true,
        ...(projectId ? { projectId } : {}),
      })
      const id = result?.id
      if (draftTimer) { clearTimeout(draftTimer); draftTimer = null }
      sent = true
      clearDraft()
      bus.closeCompose?.({ stay: true })
      bus.toast('会商已开始')
      ctx.navigate(id ? `council/${encodeURIComponent(id)}` : 'tickets')
      return
    }
    const result = await post('api/tickets', {
      text,
      ...(model ? { model } : {}),
      ...(secrets.length ? { secrets } : {}),
      ...(projectId ? { projectId } : {}),
    })
    const id = result?.ticketId ?? result?.id
    if (draftTimer) { clearTimeout(draftTimer); draftTimer = null }
    sent = true
    clearDraft()
    invalidateOverview()
    bus.toast('任务已开工')
    await bus.refreshOverview()
    bus.closeCompose?.({ stay: true })
    ctx.navigate(id ? `tickets/${id}` : 'tickets')
  }

  function clearWaiting() {
    if (!waiting) return
    waiting.cancelled = true
    waiting.cancelOnReady?.()
    waiting = null
    paintSend()
    paintWaiting()
    paintAttach()
  }

  function startWaiting(text, model, secrets) {
    clearWaiting()
    const token = { cancelled: false, cancelOnReady: null, waitsForUpload: waitsForUpload() }
    waiting = token
    paintSend()
    paintWaiting()
    const finish = async (projectId) => {
      if (waiting !== token || token.cancelled) return
      waiting = null
      state.projectId = projectId
      saveDraft()
      paintSend()
      paintWaiting()
      paintAttach()
      submitting = true
      paintSend()
      try {
        await submit(text, projectId, { model, secrets })
      } catch (error) {
        submitting = false
        paintSend()
        notify(error?.message || '项目好了，但任务没有开成；草稿还在，可以再点发送。')
      }
    }
    const failed = (message) => {
      if (waiting !== token || token.cancelled) return
      clearWaiting()
      notify(message || '项目没有准备好，任务没有开成。')
    }

    if (token.waitsForUpload) {
      token.cancelOnReady = upload.onReady((projectId) => { void finish(projectId) })
      return
    }
    if (state.projectId) {
      void (async () => {
        for (let attempt = 0; attempt < 400; attempt += 1) {
          if (waiting !== token || token.cancelled) return
          try {
            const detail = await get(`api/projects/${encodeURIComponent(state.projectId)}`)
            if (detail?.status === 'ready') { await finish(state.projectId); return }
            if (detail?.status === 'failed') { failed(detail.error || '项目解压失败，请重新上传。'); return }
          } catch (error) {
            if (error?.status === 404) { failed('这个项目不见了，请重新选择。'); return }
          }
          await new Promise((resolve) => setTimeout(resolve, 1500))
        }
        failed('等太久了，项目还没就绪；可以到项目页看看。')
      })()
      return
    }
    clearWaiting()
    notify('没有找到要等的项目，请重新选择。')
  }

  root.addEventListener('input', (event) => {
    if (event.target.matches('[data-text]')) {
      state.text = event.target.value
      autoGrow(event.target)
      scheduleSave()
    }
  })

  root.addEventListener('change', (event) => {
    if (event.target.matches('[data-model]')) {
      state.model = event.target.value
      scheduleSave()
      return
    }
    if (event.target.matches('[data-secret]')) {
      const name = event.target.value
      if (event.target.checked) {
        if (!state.secrets.includes(name)) state.secrets.push(name)
      } else {
        state.secrets = state.secrets.filter((item) => item !== name)
      }
      scheduleSave()
      paintAttach()
      return
    }
    if (event.target.matches('[data-file-input]')) {
      const file = event.target.files?.[0]
      event.target.value = ''
      pickFile(file)
    }
  })

  root.addEventListener('click', async (event) => {
    const target = event.target
    if (target.closest('[data-project-toggle]')) {
      pickerOpen = !pickerOpen
      paintPicker()
      paintAttach()
      return
    }
    if (target.closest('[data-picker-close]')) {
      pickerOpen = false
      paintPicker()
      paintAttach()
      return
    }
    if (target.closest('[data-pick-upload]')) {
      pickerOpen = false
      paintPicker()
      root.querySelector('[data-file-input]')?.click()
      return
    }
    const pick = target.closest('[data-pick-project]')
    if (pick) {
      state.projectId = pick.dataset.pickProject || ''
      pickerOpen = false
      saveDraft()
      paintPicker()
      paintProjects()
      paintAttach()
      paintSend()
      return
    }
    if (target.closest('[data-council]')) {
      if (!councilAvailable) return
      state.council = !state.council
      state.councilSet = true
      saveDraft()
      paintAttach()
      return
    }
    if (target.closest('[data-secrets-toggle]')) {
      secretsOpen = !secretsOpen
      const picker = root.querySelector('[data-secret-picker]')
      if (picker) picker.hidden = !secretsOpen
      paintAttach()
      return
    }
    if (target.closest('[data-upload-pause]')) {
      upload.pause()
      return
    }
    if (target.closest('[data-upload-resume]')) {
      await upload.resume()
      return
    }
    if (target.closest('[data-upload-cancel]')) {
      await upload.cancel()
      return
    }
    if (target.closest('[data-upload-pick]')) {
      root.querySelector('[data-file-input]')?.click()
      return
    }
    if (target.closest('[data-upload-dismiss]')) {
      upload.dismiss()
      return
    }
    if (target.closest('[data-wait-cancel]')) {
      clearWaiting()
      return
    }
    if (!target.closest('[data-send]')) return
    if (submitting || waiting) return
    const textarea = root.querySelector('[data-text]')
    const text = textarea?.value?.trim()
    if (!text) {
      bus.toast('先写一句要它做什么', { danger: true })
      return
    }
    state.text = text
    state.model = root.querySelector('[data-model]')?.value || ''
    state.secrets = [...root.querySelectorAll('[data-secret]:checked')].map((input) => input.value)
    saveDraft()

    if (willWait()) {
      startWaiting(text, state.model, state.secrets)
      return
    }
    submitting = true
    paintSend()
    try {
      await submit(text, state.projectId, {
        council: state.council,
        model: state.model,
        secrets: state.secrets,
      })
    } catch (error) {
      notify(error?.message || '没有发出去，草稿还在，可以再试。')
    } finally {
      submitting = false
      paintSend()
    }
  })

  root.addEventListener('keydown', (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
      event.preventDefault()
      root.querySelector('[data-send]')?.click()
    }
  })

  root.addEventListener('dragover', (event) => {
    if (!event.dataTransfer?.types?.includes('Files')) return
    event.preventDefault()
    root.dataset.dragging = 'true'
  })
  root.addEventListener('dragleave', (event) => {
    if (event.target !== root) return
    delete root.dataset.dragging
  })
  root.addEventListener('drop', (event) => {
    if (!event.dataTransfer?.files?.length) return
    event.preventDefault()
    delete root.dataset.dragging
    pickFile(event.dataTransfer.files[0])
  })

  unsubscribeUpload = upload.subscribe((next) => {
    const previous = uploadState
    uploadState = next
    if (alive) {
      paintUploadCard()
      paintAttach()
    }
    if (previous.phase !== next.phase) {
      if (next.phase === 'done' && next.projectId && lastDoneProject !== next.projectId) {
        lastDoneProject = next.projectId
        state.projectId = next.projectId
        saveDraft()
        void refreshProjectList()
      }
      if (next.phase === 'failed' && waiting?.waitsForUpload) {
        clearWaiting()
        notify(next.error || '项目没有准备好，任务没有开成。')
      }
      if (next.phase === 'idle' && waiting?.waitsForUpload) {
        clearWaiting()
        notify('上传已经取消，任务没有开成。草稿还在，可以再点发送。')
      }
    }
  })

  async function refreshProjectList() {
    try {
      const result = await get('api/projects')
      if (!alive) return
      projectItems = Array.isArray(result?.items) ? result.items : []
      projectsLoaded = true
      paintProjects()
      paintAttach()
    } catch {
      // The picker keeps its previous list; the send path does not depend on it.
    }
  }

  render()

  return {
    root,
    refresh: async () => {
      await refreshProjectList()
      if (!submitting && !waiting) paintStats()
    },
    destroy() {
      alive = false
      if (draftTimer) clearTimeout(draftTimer)
      unsubscribeUpload?.()
      clearWaiting()
      if (sent) return
      if (state.text.trim()) saveDraft()
      else clearDraft()
    },
  }
}

/** The full page version (kept for direct mounting and older links). */
export function mount(ctx) {
  const form = createCompose(ctx)
  return { root: form.root, refresh: async () => form.refresh(), destroy: () => form.destroy() }
}

/** The dialog body. The shell owns the dialog, focus trap and backdrop. */
export function mountPanel(ctx, { preset = {} } = {}) {
  const form = createCompose(ctx, { preset, panel: true })
  return { root: form.root, refresh: async () => form.refresh(), destroy: () => form.destroy() }
}
