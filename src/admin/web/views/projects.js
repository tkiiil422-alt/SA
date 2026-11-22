/**
 * 项目：upload an archive, watch progress/extraction, and list the library.
 *
 * Rows are grouped list items (separator lines), not cards. The one card on the
 * page is the active upload, because that is the only thing that needs a border
 * and a progress bar.
 */
import { get } from '../lib/api.js'
import { bus } from '../lib/bus.js'
import { esc, ago } from '../lib/view.js'
import { bytes, duration } from '../lib/format.js'
import * as upload from '../lib/upload.js'

const MIB = 1024 * 1024

function speedText(value) {
  const speed = Number(value)
  if (!Number.isFinite(speed) || speed <= 0) return '速度算不出来'
  return `${bytes(speed)}/秒`
}

function etaText(value) {
  const seconds = Number(value)
  if (!Number.isFinite(seconds) || seconds <= 0) return '正在估算剩余时间'
  return `剩余约 ${duration(seconds)}`
}

function statusHtml(item, progress) {
  if (item.status === 'uploading') {
    return '<span class="pstat" data-s="uploading"><i class="pstat__mark" aria-hidden="true"></i>上传中</span>'
  }
  if (item.status === 'extracting') {
    const done = Number(progress?.done) || 0
    const total = Number(progress?.total) || 0
    const text = total > 0
      ? `正在解压 ${done.toLocaleString('en-US')} / ${total.toLocaleString('en-US')}`
      : '正在解压'
    const pct = total > 0 ? Math.max(0, Math.min(100, Math.round((done / total) * 100))) : 0
    return `<span class="pstat" data-s="extracting"><i class="pstat__mark" aria-hidden="true"></i>解压中</span>
      <span class="prow__progress">
        <span class="upbar upbar--slim" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}"><i style="width:${pct}%"></i></span>
        <span class="hint">${esc(text)}</span>
      </span>`
  }
  if (item.status === 'failed') {
    return '<span class="pstat" data-s="failed"><i class="pstat__mark" aria-hidden="true"></i>失败</span>'
  }
  return '<span class="pstat" data-s="ready"><i class="pstat__mark" aria-hidden="true"></i>可用</span>'
}

function rowHtml(item, progress) {
  const files = Number(item.files ?? 0).toLocaleString('en-US')
  return `<a class="prow" href="#/projects/${encodeURIComponent(item.id)}">
    <span class="prow__main">
      <span class="prow__top"><span class="prow__title">${esc(item.name)}</span><span class="prow__time">${esc(ago(item.createdAt))}</span></span>
      <span class="prow__meta"><span>${files} 个文件</span><span>${bytes(item.bytes ?? 0)}</span></span>
      <span class="prow__status">${statusHtml(item, progress)}</span>
      ${item.status === 'failed' && item.error ? `<span class="prow__error">${esc(item.error)}</span>` : ''}
    </span>
    <span class="prow__side" aria-hidden="true">›</span>
  </a>`
}

export function mount(ctx) {
  const root = document.createElement('div')
  root.className = 'page projects-page'
  root.innerHTML = `
    <div class="head">
      <div class="head__row"><h1 class="head__title">项目</h1></div>
      <p class="head__sub">上传一个项目压缩包，之后就能在这个成熟项目上开任务</p>
    </div>
    <div class="drop" data-drop>
      <div class="drop__text">
        <span class="drop__title">把 .zip 拖到这里</span>
        <span class="drop__hint" data-drop-hint>压缩包最大 4096 MB；传一半断了可以接着传</span>
      </div>
      <button class="btn btn--ink" type="button" data-pick>上传项目</button>
    </div>
    <div data-resume></div>
    <div data-upload></div>
    <section class="section">
      <div class="section__head">
        <h2 class="section__title">全部项目</h2>
        <span class="section__count" data-count></span>
      </div>
      <div data-list><p class="hint">正在读项目…</p></div>
    </section>
    <input type="file" hidden accept=".zip,application/zip" data-file-input>
    <input type="file" hidden accept=".zip,application/zip" data-resume-input>`

  const listHost = root.querySelector('[data-list]')
  const countHost = root.querySelector('[data-count]')
  const uploadHost = root.querySelector('[data-upload]')
  const resumeHost = root.querySelector('[data-resume]')
  const fileInput = root.querySelector('[data-file-input]')
  const resumeInput = root.querySelector('[data-resume-input]')
  let alive = true
  let items = []
  let progressById = new Map()
  let projectSettings = { maxUploadMb: 4096 }
  let uploadState = upload.state()
  let unsubscribe = null
  let lastDoneProject = uploadState.phase === 'done' ? uploadState.projectId : ''
  let pendingChecked = false
  let pendingRecord = null

  function notify(message) {
    bus.toast(message, { danger: true })
  }

  function renderDropHint() {
    const hint = root.querySelector('[data-drop-hint]')
    if (hint) hint.textContent = `压缩包最大 ${projectSettings.maxUploadMb} MB；传一半断了可以接着传`
  }

  function renderList() {
    if (!alive) return
    countHost.textContent = items.length ? `${items.length} 个` : ''
    if (!items.length) {
      listHost.innerHTML = `<div class="empty">
        <p class="empty__title">还没有项目</p>
        <p class="empty__text">上传一个项目压缩包，之后开任务时就能让它在现有代码上改，而不是从空目录开始。</p>
        <button class="btn btn--ink" type="button" data-pick>上传项目</button>
      </div>`
      return
    }
    listHost.innerHTML = `<div class="plist">${items.map((item) => rowHtml(item, progressById.get(item.id))).join('')}</div>`
  }

  function renderUpload() {
    if (!alive) return
    const state = uploadState
    if (!state || state.phase === 'idle') {
      uploadHost.innerHTML = ''
      return
    }
    const pct = Math.max(0, Math.min(100, Math.round(Number(state.percent) || 0)))
    const bar = `<div class="upbar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}"><i style="width:${pct}%"></i></div>`
    if (state.phase === 'done') {
      uploadHost.innerHTML = `<div class="upcard upcard--done">
        <div class="upcard__head"><span class="upcard__name">${esc(state.name || '压缩包')}</span><span class="pstat upcard__state" data-s="ready"><i class="pstat__mark" aria-hidden="true"></i>项目已上传</span></div>
        ${bar}
        <div class="upcard__foot">
          <span>${bytes(state.size ?? 0)}，解压完成，可以开任务了</span>
          ${state.projectId ? `<a class="btn btn--ink" href="#/projects/${encodeURIComponent(state.projectId)}">打开项目</a>` : ''}
        </div>
      </div>`
      return
    }
    if (state.phase === 'failed') {
      uploadHost.innerHTML = `<div class="upcard upcard--failed">
        <div class="upcard__head"><span class="upcard__name">${esc(state.name || '压缩包')}</span><span class="pstat upcard__state" data-s="failed"><i class="pstat__mark" aria-hidden="true"></i>上传失败</span></div>
        <p class="upcard__error">${esc(state.error || '上传没有成功。')}</p>
        <div class="upcard__actions">
          ${upload.pending() ? '<button class="btn" type="button" data-pick>选择同一个文件继续</button>' : '<button class="btn" type="button" data-pick>重新选择文件</button>'}
          <button class="btn btn--quiet" type="button" data-upload-dismiss>收起</button>
        </div>
      </div>`
      return
    }
    if (state.phase === 'finishing' || state.phase === 'extracting') {
      const extract = state.phase === 'finishing'
        ? '正在收尾'
        : state.extractTotal > 0
          ? `正在解压 ${Number(state.extractDone).toLocaleString('en-US')} / ${Number(state.extractTotal).toLocaleString('en-US')}`
          : '正在解压'
      uploadHost.innerHTML = `<div class="upcard">
        <div class="upcard__head"><span class="upcard__name">${esc(state.name || '压缩包')}</span><span class="pstat upcard__state" data-s="extracting"><i class="pstat__mark" aria-hidden="true"></i>${esc(extract)}</span></div>
        ${bar}
        <div class="upcard__foot">
          <span>${state.phase === 'finishing' ? '上传完了，正在交给解压' : '解压完就能开任务'}</span>
          ${state.projectId ? `<a class="btn btn--quiet" href="#/projects/${encodeURIComponent(state.projectId)}">看项目</a>` : ''}
        </div>
      </div>`
      return
    }
    const paused = state.phase === 'paused'
    uploadHost.innerHTML = `<div class="upcard">
      <div class="upcard__head"><span class="upcard__name">${esc(state.name || '压缩包')}</span><span class="pstat upcard__state" data-s="${paused ? 'paused' : 'uploading'}"><i class="pstat__mark" aria-hidden="true"></i>${paused ? '已暂停' : '正在上传'}</span></div>
      ${bar}
      <div class="upcard__meta">
        <span>${bytes(state.sent ?? 0)} / ${bytes(state.size ?? 0)}</span>
        <span>${speedText(state.speedBps)}</span>
        ${Number(state.etaSec) > 0 ? `<span>${etaText(state.etaSec)}</span>` : ''}
      </div>
      ${state.notice ? `<p class="upcard__notice">${esc(state.notice)}</p>` : ''}
      <div class="upcard__actions">
        ${paused
          ? '<button class="btn btn--ink" type="button" data-upload-resume>继续</button>'
          : '<button class="btn" type="button" data-upload-pause>暂停</button>'}
        <button class="btn btn--danger" type="button" data-upload-cancel>取消</button>
      </div>
    </div>`
  }

  async function renderResume() {
    if (!alive || uploadState.active) {
      resumeHost.innerHTML = ''
      return
    }
    const record = upload.pending()
    if (!record) {
      pendingRecord = null
      resumeHost.innerHTML = ''
      return
    }
    if (record.projectId) {
      resumeHost.innerHTML = `<div class="resumebar">
        <span>上次上传的项目还在解压。</span>
        <a class="btn btn--quiet" href="#/projects/${encodeURIComponent(record.projectId)}">看项目</a>
      </div>`
      return
    }
    if (!pendingChecked) {
      pendingChecked = true
      try {
        const info = await get(`api/uploads/${encodeURIComponent(record.uploadId)}`)
        if (!alive) return
        pendingRecord = { ...record, received: Number(info?.received) || 0 }
      } catch (error) {
        pendingRecord = null
        if (error?.status === 404) {
          upload.forgetPending()
          notify('上次的上传已经被清理了，请重新选择文件上传。')
        } else {
          notify(error?.message || '读不到上次的上传进度。')
        }
        resumeHost.innerHTML = ''
        return
      }
    }
    if (!pendingRecord) return
    const pct = pendingRecord.size > 0
      ? Math.max(0, Math.min(100, Math.round((pendingRecord.received / pendingRecord.size) * 100)))
      : 0
    resumeHost.innerHTML = `<div class="resumebar">
      <span class="resumebar__text">上次的上传没传完：${esc(pendingRecord.name)}（已 ${pct}%）。选择同一个文件就能接着传。</span>
      <span class="resumebar__acts">
        <button class="btn" type="button" data-resume-pick>选择同一个文件继续</button>
        <button class="btn btn--quiet" type="button" data-resume-cancel>取消上次的上传</button>
      </span>
    </div>`
  }

  function applyUploadState(next) {
    const previous = uploadState
    uploadState = next
    renderUpload()
    renderResume()
    if (previous.phase !== next.phase) {
      if (next.phase === 'done' && next.projectId && lastDoneProject !== next.projectId) {
        lastDoneProject = next.projectId
        bus.toast('项目已上传')
        void refreshList()
      }
      if (next.phase === 'failed' && next.error) {
        bus.toast(next.error, { danger: true })
        pendingChecked = false
      }
      if (next.phase === 'paused' && next.notice) {
        bus.toast(next.notice, { danger: next.notice.includes('登录') })
      }
    }
  }

  async function refreshList() {
    try {
      const result = await get('api/projects')
      if (!alive) return
      items = Array.isArray(result?.items) ? result.items : []
      const extracting = items.filter((item) => item.status === 'extracting' || item.status === 'uploading')
      const details = await Promise.all(extracting.map((item) =>
        get(`api/projects/${encodeURIComponent(item.id)}`).catch(() => null)))
      if (!alive) return
      progressById = new Map()
      extracting.forEach((item, index) => {
        const detail = details[index]
        if (detail?.progress) progressById.set(item.id, detail.progress)
      })
      renderList()
    } catch (error) {
      if (!alive) return
      listHost.innerHTML = `<p class="hint">读不到项目列表：${esc(error?.message || '请求失败')}</p>`
    }
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
    upload.start(file, {}).catch((error) => notify(error?.message || '上传没有开始。'))
  }

  root.addEventListener('change', (event) => {
    if (event.target.matches('[data-file-input]') || event.target.matches('[data-resume-input]')) {
      const file = event.target.files?.[0]
      event.target.value = ''
      pickFile(file)
    }
  })

  root.addEventListener('click', async (event) => {
    if (event.target.closest('[data-pick]')) {
      fileInput?.click()
      return
    }
    if (event.target.closest('[data-resume-pick]')) {
      resumeInput?.click()
      return
    }
    if (event.target.closest('[data-resume-cancel]')) {
      pendingRecord = null
      pendingChecked = false
      await upload.cancel()
      resumeHost.innerHTML = ''
      return
    }
    if (event.target.closest('[data-upload-pause]')) {
      upload.pause()
      return
    }
    if (event.target.closest('[data-upload-resume]')) {
      await upload.resume()
      return
    }
    if (event.target.closest('[data-upload-cancel]')) {
      pendingRecord = null
      pendingChecked = false
      await upload.cancel()
      resumeHost.innerHTML = ''
      return
    }
    if (event.target.closest('[data-upload-dismiss]')) {
      upload.dismiss()
      pendingChecked = false
      void renderResume()
    }
  })

  // Desktop drop area. A depth counter keeps child dragenter/leave from flickering.
  const drop = root.querySelector('[data-drop]')
  let dragDepth = 0
  drop?.addEventListener('dragenter', (event) => {
    if (!event.dataTransfer?.types?.includes('Files')) return
    event.preventDefault()
    dragDepth += 1
    drop.dataset.drag = 'true'
  })
  drop?.addEventListener('dragover', (event) => {
    if (!event.dataTransfer?.types?.includes('Files')) return
    event.preventDefault()
  })
  drop?.addEventListener('dragleave', () => {
    dragDepth = Math.max(0, dragDepth - 1)
    if (dragDepth === 0) delete drop.dataset.drag
  })
  drop?.addEventListener('drop', (event) => {
    event.preventDefault()
    dragDepth = 0
    delete drop.dataset.drag
    const files = event.dataTransfer?.files
    if (!files?.length) return
    if (files.length > 1) {
      notify('一次只能传一个项目压缩包。')
      return
    }
    pickFile(files[0])
  })

  unsubscribe = upload.subscribe(applyUploadState)

  void (async () => {
    try {
      const settings = await get('api/settings/projects')
      if (Number(settings?.maxUploadMb) > 0) projectSettings = settings
    } catch {
      // Keep the documented default; the server still enforces its own limit.
    }
    if (!alive) return
    renderDropHint()
    renderUpload()
    await refreshList()
    pendingChecked = false
    await renderResume()
  })()

  return {
    root,
    refresh: async () => {
      if (upload.state().active) {
        uploadState = upload.state()
        renderUpload()
      } else {
        await renderResume()
      }
      await refreshList()
    },
    destroy() {
      alive = false
      unsubscribe?.()
    },
  }
}
