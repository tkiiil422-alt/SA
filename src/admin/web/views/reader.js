/**
 * 文档阅读器：整页读报告 / 项目文档 / 任务书。
 *
 * 路由： #/doc/ticket/<ticketId>?path=<相对路径>
 *        #/doc/project/<projectId>?path=<相对路径>
 *        #/doc/council/<councilId>    （任务书，GET api/councils/:id 的 brief）
 *
 * 约定：
 * - 文件接口形状与 src/admin/api.ts 的 handleFiles 一致：
 *   dir  -> { exists, type:'dir', entries:[{name,type,size}] }
 *   file -> { exists, type:'file', name, size, modifiedAt, text?, truncated?, binary? }
 *   图片用同一地址加 raw=1；下载用 download=1。
 * - 3 秒轮询的 refresh 故意不重绘：读长文时重新请求会打断滚动与目录高亮。
 * - 目录按钮不写 location.hash（会触发壳层路由），只用 scrollIntoView。
 */
import { request } from '../lib/api.js'
import { relTime } from '../lib/format.js'
import { esc, icons } from '../lib/view.js'
import { renderDoc } from '../lib/markdown.js'

const IMAGE_EXT = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif']
const CODE_EXT = ['js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'py', 'go', 'rs', 'java', 'kt', 'rb', 'php', 'c', 'h', 'cc', 'cpp', 'hpp', 'cs', 'sh', 'bash', 'zsh', 'ps1', 'sql', 'yaml', 'yml', 'toml', 'ini', 'conf', 'xml', 'css', 'scss', 'less', 'vue', 'svelte', 'dart', 'swift', 'lua', 'r', 'm', 'gradle', 'dockerfile', 'makefile']
const FONT_KEY = 'sa-reader-font'
/* ?mock=1 has no HTTP backend for <img src="api/...">, so the image bytes are
   fetched through the mock's window.fetch and shown from a blob URL. */
const IS_MOCK = typeof location !== 'undefined' && new URLSearchParams(location.search).get('mock') === '1'
const TRANSPARENT_PIXEL = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'

function extensionOf(name) {
  const value = String(name ?? '')
  const at = value.lastIndexOf('.')
  return at >= 0 ? value.slice(at + 1).toLowerCase() : ''
}

function kindLabel(kind) {
  return kind === 'project' ? '项目文件' : kind === 'council' ? '任务书' : '任务产出'
}

function backHref(kind, id) {
  if (kind === 'project') return `#/projects/${encodeURIComponent(id)}`
  if (kind === 'council') return `#/council/${encodeURIComponent(id)}`
  return `#/tickets/${encodeURIComponent(id)}`
}

function sizeText(bytes) {
  const value = Number(bytes)
  if (!Number.isFinite(value) || value < 0) return ''
  if (value < 1024) return `${value} 字节`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(value < 10 * 1024 ? 1 : 0)} KB`
  if (value < 1024 * 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`
  return `${(value / (1024 * 1024 * 1024)).toFixed(1)} GB`
}

function normalizePath(raw) {
  const parts = []
  for (const segment of String(raw ?? '').replace(/\\/g, '/').split('/')) {
    if (!segment || segment === '.') continue
    if (segment === '..') {
      if (!parts.length) return null
      parts.pop()
      continue
    }
    if (segment.includes('\u0000')) return null
    parts.push(segment)
  }
  return parts.join('/')
}

function relativeTo(reference, docPath) {
  const value = String(reference ?? '').trim()
  if (!value || value.startsWith('#')) return null
  if (/^[a-z][a-z0-9+.-]*:/i.test(value) || value.startsWith('//')) return null
  const pure = value.split(/[?#]/)[0]
  if (!pure) return null
  let decoded = pure
  try { decoded = decodeURIComponent(pure) } catch { /* keep the raw form */ }
  const base = docPath ? docPath.split('/').slice(0, -1) : []
  return normalizePath([...base, decoded].join('/'))
}

function parseCsv(text, limit = 500) {
  const rows = []
  let row = []
  let field = ''
  let quoted = false
  let capped = false
  const pushRow = () => {
    row.push(field)
    rows.push(row)
    row = []
    field = ''
    if (rows.length > limit) capped = true
  }
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"'
          index += 1
        } else {
          quoted = false
        }
      } else {
        field += char
      }
      continue
    }
    if (char === '"') { quoted = true; continue }
    if (char === ',') { row.push(field); field = ''; continue }
    if (char === '\r') continue
    if (char === '\n') { pushRow(); continue }
    field += char
  }
  if (field !== '' || row.length) pushRow()
  return { rows: rows.slice(0, limit), more: capped }
}

function csvHtml(text) {
  const parsed = parseCsv(text)
  if (!parsed.rows.length) return '<p class="reader-note">这份 CSV 是空的。</p>'
  const [head, ...body] = parsed.rows
  const width = head.length
  const th = head.map((cell) => `<th>${esc(cell)}</th>`).join('')
  const trs = body.map((row) => `<tr>${Array.from({ length: width }, (_, index) => `<td>${esc(row[index] ?? '')}</td>`).join('')}</tr>`).join('')
  return `<div class="table-wrap"><table class="md-table reader-csv"><thead><tr>${th}</tr></thead><tbody>${trs}</tbody></table></div>` +
    (parsed.more ? '<p class="reader-note">只显示前 500 行，其余请下载原文件。</p>' : '')
}

function plainText(value) {
  return String(value ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
}

export function mount(ctx) {
  const kind = ctx?.params?.kind === 'project' ? 'project' : ctx?.params?.kind === 'council' ? 'council' : 'ticket'
  const id = ctx?.params?.id ?? ''
  const path = kind === 'council' ? '' : normalizePath(ctx?.query?.path ?? '') ?? ''

  const root = document.createElement('div')
  root.className = 'page reader-page'
  root.dataset.kind = kind

  const state = {
    alive: true,
    phase: 'loading',
    error: '',
    data: null,
    doc: null,
    truncated: false,
    bodyHtml: '',
    toc: [],
    rawText: '',
    textKind: '',
    folder: null,
    font: (() => {
      try { return localStorage.getItem(FONT_KEY) === 'ui' ? 'ui' : 'read' } catch { return 'read' }
    })(),
    observer: null,
    copiedTimer: null,
  }

  const encodedId = encodeURIComponent(id)
  const filesBase = kind === 'project'
    ? `api/projects/${encodedId}/files`
    : `api/tickets/${encodedId}/files`

  const fileUrl = (filePath, extra = '') => {
    const search = new URLSearchParams()
    search.set('path', filePath)
    const base = `${filesBase}?${search.toString()}`
    return extra ? `${base}&${extra}` : base
  }
  const rawUrl = (filePath) => fileUrl(filePath, 'raw=1')
  const downloadUrl = (filePath) => fileUrl(filePath, 'download=1')
  const docRoute = (filePath) => `#/doc/${kind}/${encodedId}?path=${encodeURIComponent(filePath)}`

  const resolveImage = (source) => {
    const target = relativeTo(source, path)
    if (!target) return null
    const name = target.split('/').pop() ?? ''
    if (!IMAGE_EXT.includes(extensionOf(name))) return null
    return rawUrl(target)
  }
  const resolveLink = (href) => {
    const target = relativeTo(href, path)
    if (!target) return null
    if (/\.(?:md|markdown)$/i.test(target)) return docRoute(target)
    return fileUrl(target)
  }

  function goBack() {
    if (history.length > 1) {
      history.back()
      return
    }
    location.hash = backHref(kind, id)
  }

  function parentPath(filePath) {
    return filePath.split('/').slice(0, -1).join('/')
  }

  /* ---------- data ---------- */

  async function load() {
    if (kind === 'council') {
      await loadCouncil()
      return
    }
    try {
      const data = await request(fileUrl(path))
      if (!state.alive) return
      state.data = data
      if (!data || data.exists === false) {
        state.phase = 'missing'
        paint()
        return
      }
      if (data.type === 'dir') {
        state.folder = Array.isArray(data.entries) ? data.entries : []
        state.phase = 'folder'
        paint()
        return
      }
      const name = data.name || path.split('/').pop() || '文档'
      const ext = extensionOf(name)

      if (IMAGE_EXT.includes(ext)) {
        state.textKind = 'image'
        state.phase = 'ready'
        paint()
        return
      }
      if (data.binary) {
        state.textKind = 'binary'
        state.phase = 'ready'
        paint()
        return
      }

      const text = plainText(data.text ?? '')
      state.rawText = text
      state.textKind = ext
      state.truncated = Boolean(data.truncated)

      if (ext === 'md' || ext === 'markdown') {
        state.doc = renderDoc(text, { resolveImage, resolveLink, headingIds: true })
        state.toc = state.doc.toc
      } else if (ext === 'csv') {
        state.bodyHtml = csvHtml(text)
      } else if (ext === 'json') {
        try {
          state.bodyHtml = `<pre class="reader-pre"><code class="lang-json">${esc(JSON.stringify(JSON.parse(text), null, 2))}</code></pre>`
        } catch {
          state.bodyHtml = `<pre class="reader-pre"><code>${esc(text)}</code></pre>`
        }
      } else if (ext === 'html' || ext === 'htm') {
        state.bodyHtml = `<pre class="reader-pre"><code class="lang-html">${esc(text)}</code></pre>`
      } else {
        const lang = CODE_EXT.includes(ext) ? ` class="lang-${esc(ext)}"` : ''
        state.bodyHtml = `<pre class="reader-pre"><code${lang}>${esc(text)}</code></pre>`
      }
      state.phase = 'ready'
      paint()
    } catch (error) {
      if (!state.alive) return
      if (error?.status === 404) {
        state.phase = 'missing'
      } else {
        state.phase = 'error'
        state.error = error?.message || '读不到这份文档'
      }
      paint()
    }
  }

  async function loadCouncil() {
    try {
      const data = await request(`api/councils/${encodedId}`)
      if (!state.alive) return
      state.data = data
      const text = plainText(data?.brief ?? '')
      if (!text.trim()) {
        state.phase = 'missing'
        paint()
        return
      }
      state.rawText = text
      state.textKind = 'md'
      state.doc = renderDoc(text, { headingIds: true })
      state.toc = state.doc.toc
      state.phase = 'ready'
      paint()
    } catch (error) {
      if (!state.alive) return
      state.phase = 'missing'
      state.error = error?.message || ''
      paint()
    }
  }

  /* ---------- copy ---------- */

  function showManual(text) {
    const panel = root.querySelector('[data-manual]')
    if (!panel) return
    const area = panel.querySelector('[data-manual-text]')
    if (area) area.value = text
    panel.hidden = false
    if (area) {
      area.focus()
      area.select()
    }
  }

  async function copyText(text) {
    const value = String(text ?? '')
    try {
      if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        await navigator.clipboard.writeText(value)
        return true
      }
    } catch { /* clipboard may be blocked on plain http; fall through */ }
    try {
      const area = document.createElement('textarea')
      area.value = value
      area.setAttribute('readonly', '')
      area.style.position = 'fixed'
      area.style.top = '-1000px'
      area.style.opacity = '0'
      document.body.appendChild(area)
      area.focus()
      area.select()
      const ok = document.execCommand('copy')
      area.remove()
      if (ok) return true
    } catch { /* fall through to the manual panel */ }
    showManual(value)
    return false
  }

  function announce(text) {
    const live = root.querySelector('[data-copy-live]')
    if (live) live.textContent = text
  }

  function flashCopied(button) {
    if (!button) return
    if (!button.dataset.label) button.dataset.label = button.textContent || '复制'
    button.textContent = '已复制'
    button.dataset.copied = 'true'
    if (state.copiedTimer) clearTimeout(state.copiedTimer)
    state.copiedTimer = setTimeout(() => {
      if (!button.isConnected) return
      button.textContent = button.dataset.label || '复制'
      delete button.dataset.copied
    }, 1600)
  }

  /* ---------- table of contents ---------- */

  function tocLinksHtml() {
    const items = state.toc.map((entry) => `
      <li class="reader-toc__item is-h${entry.level}">
        <button type="button" class="reader-toc__link" data-toc-id="${esc(entry.id)}">${esc(entry.text)}</button>
      </li>`).join('')
    return `<ol class="reader-toc__list">${items}</ol>`
  }

  function setActive(idValue) {
    for (const link of root.querySelectorAll('[data-toc-id]')) {
      const active = link.dataset.tocId === idValue
      link.classList.toggle('is-active', active)
      if (active) link.setAttribute('aria-current', 'true')
      else link.removeAttribute('aria-current')
    }
  }

  function setupObserver() {
    state.observer?.disconnect()
    state.observer = null
    if (typeof IntersectionObserver !== 'function') return
    const headings = [...root.querySelectorAll('.reader-body h2[id], .reader-body h3[id]')]
    if (!headings.length) return
    const visible = new Map()
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) visible.set(entry.target.id, entry.boundingClientRect.top)
        else visible.delete(entry.target.id)
      }
      if (!visible.size) return
      for (const heading of headings) {
        if (visible.has(heading.id)) {
          setActive(heading.id)
          break
        }
      }
    }, { rootMargin: '-60px 0px -60% 0px', threshold: 0 })
    for (const heading of headings) observer.observe(heading)
    state.observer = observer
    setActive(headings[0].id)
  }

  /* ---------- markup ---------- */

  function crumbsHtml(name) {
    const parts = path ? path.split('/') : []
    const segments = parts.map((segment, index) => {
      const last = index === parts.length - 1
      return `<span class="reader-crumb${last ? ' is-last' : ''}">${esc(segment)}</span>`
    })
    return `<span class="reader-crumb-kind">${esc(kindLabel(kind))}</span>${segments.join('<span class="reader-crumb-sep" aria-hidden="true">/</span>')}${name && parts.at(-1) !== name ? `<span class="reader-crumb is-last">${esc(name)}</span>` : ''}`
  }

  function metaHtml(data) {
    const pieces = []
    const size = sizeText(data?.size)
    if (size) pieces.push(`<span>${esc(size)}</span>`)
    if (data?.modifiedAt) pieces.push(`<span>${esc(relTime(data.modifiedAt))}</span>`)
    if (kind === 'council' && data?.updatedAt) pieces.push(`<span>${esc(relTime(data.updatedAt))}</span>`)
    return pieces.join('')
  }

  function toolbarHtml() {
    if (state.phase !== 'ready') return ''
    const canCopy = Boolean(state.rawText)
    const fontRead = state.font !== 'ui'
    return `
      <div class="reader-tools" role="toolbar" aria-label="文档工具">
        <button class="btn reader-tool" type="button" data-copy-all${canCopy ? '' : ' disabled'}>复制全文</button>
        ${kind === 'council' ? '' : `<a class="btn reader-tool" href="${esc(downloadUrl(path))}">下载原文件</a>`}
        <button class="btn reader-tool" type="button" data-print>打印</button>
        <span class="reader-font" role="group" aria-label="字体">
          <button class="reader-font__btn" type="button" data-font="read" aria-pressed="${fontRead}">阅读体</button>
          <button class="reader-font__btn" type="button" data-font="ui" aria-pressed="${!fontRead}">界面体</button>
        </span>
      </div>`
  }

  function fileBodyHtml() {
    if (state.textKind === 'image') {
      const raw = rawUrl(path)
      const src = IS_MOCK ? TRANSPARENT_PIXEL : raw
      const dataRaw = IS_MOCK ? ` data-raw-src="${esc(raw)}"` : ''
      return `<figure class="reader-figure">
        <img src="${esc(src)}"${dataRaw} alt="${esc(path.split('/').pop() || '图片')}">
        <figcaption>${esc(path)}</figcaption>
      </figure>`
    }
    if (state.textKind === 'binary') {
      return `<div class="reader-note" role="note">
        <p>这是个二进制文件，不能在页面里读。</p>
        <p><a class="btn" href="${esc(downloadUrl(path))}">下载原文件</a></p>
      </div>`
    }
    if (state.textKind === 'md' || state.textKind === 'markdown') {
      let html = state.doc?.html ?? ''
      if (IS_MOCK) {
        html = html.replace(/<img src="([^"]*raw=1[^"]*)"/g, (_, src) => `<img data-raw-src="${src}" src="${TRANSPARENT_PIXEL}"`)
      }
      return `<article class="read reader-body" id="reader-body">${html}</article>`
    }
    return `<article class="reader-body">${state.bodyHtml}</article>`
  }

  function noteHtml() {
    if (!state.truncated) return ''
    const download = kind === 'council' ? '' : ` <a href="${esc(downloadUrl(path))}">下载原文件</a>`
    return `<div class="reader-note" role="note">文件太大，只显示了开头一部分。${download}</div>`
  }

  function folderHtml() {
    const entries = state.folder ?? []
    const parent = parentPath(path)
    const parentLink = path
      ? `<a class="reader-folder__up" href="${esc(docRoute(parent))}">上一级</a>`
      : `<a class="reader-folder__up" href="${esc(backHref(kind, id))}">返回</a>`
    const list = entries.length
      ? `<ul class="reader-folder__list">${entries.map((entry) => {
          const child = normalizePath(path ? `${path}/${entry.name}` : entry.name) ?? entry.name
          const name = entry.type === 'dir' ? `${entry.name}/` : entry.name
          return `<li><a class="reader-folder__item" href="${esc(docRoute(child))}">
            <span class="reader-folder__name">${esc(name)}</span>
            ${entry.type === 'file' && Number.isFinite(Number(entry.size)) ? `<span class="reader-folder__size">${esc(sizeText(entry.size))}</span>` : '<span class="reader-folder__size">文件夹</span>'}
          </a></li>`
        }).join('')}</ul>`
      : '<p class="reader-note">这个文件夹是空的。</p>'
    return `
      <div class="reader-folder">
        <h1 class="reader-folder__title">这是个文件夹</h1>
        <p class="reader-folder__path">${esc(path || '根目录')}</p>
        ${parentLink}
        ${list}
      </div>`
  }

  function readyHtml() {
    if (kind === 'council') {
      return `${noteHtml()}<article class="read reader-body" id="reader-body">${state.doc?.html ?? ''}</article>`
    }
    return noteHtml() + fileBodyHtml()
  }

  function tocHtml() {
    if (state.phase !== 'ready' || !state.toc.length) return ''
    const links = tocLinksHtml()
    return `
      <details class="reader-toc-fold" data-keep="reader.toc">
        <summary>目录 <span class="reader-toc__count">${state.toc.length} 节</span></summary>
        <nav class="reader-toc__nav" aria-label="目录">${links}</nav>
      </details>`
  }

  function paint() {
    state.observer?.disconnect()
    state.observer = null
    const data = state.data
    const name = data?.name || (kind === 'ticket' ? '文档' : kindLabel(kind))
    const crumbs = crumbsHtml(name)
    const meta = metaHtml(data)
    const toolbar = toolbarHtml()

    let content = ''
    if (state.phase === 'loading') {
      content = `<div class="reader-skeleton" aria-busy="true" aria-label="正在读取文档">
        <span></span><span></span><span></span><span></span><span></span>
      </div>`
    } else if (state.phase === 'missing') {
      const title = kind === 'council' ? '读不到这份文档' : '这份文档不存在了'
      const text = kind === 'council' ? '任务书还没生成，或者会商记录已经被删掉了。' : '它可能被移动、改名或删除了。'
      content = `<div class="empty">
        <p class="empty__title">${esc(title)}</p>
        <p class="empty__text">${esc(text)}</p>
        <a class="btn" href="${esc(backHref(kind, id))}" style="margin-top:12px">返回</a>
      </div>`
    } else if (state.phase === 'error') {
      content = `<div class="empty">
        <p class="empty__title">读不到这份文档</p>
        <p class="empty__text">${esc(state.error || '网络不太顺，稍后再试一次。')}</p>
        <button class="btn" type="button" data-retry style="margin-top:12px">重试</button>
      </div>`
    } else if (state.phase === 'folder') {
      content = folderHtml()
    } else {
      content = readyHtml()
    }

    const hasToc = state.phase === 'ready' && state.toc.length > 0
    const layout = hasToc
      ? `<div class="reader-layout">
          <div class="reader-main">${content}</div>
          <aside class="reader-toc" aria-label="目录">
            <p class="reader-toc__title">目录</p>
            <nav class="reader-toc__nav">${tocLinksHtml()}</nav>
          </aside>
        </div>`
      : content

    root.innerHTML = `
      <div class="reader-top">
        <div class="reader-back-row">
          <a class="btn btn--quiet reader-back" href="${esc(backHref(kind, id))}">${icons.back} 返回</a>
          <span class="reader-esc-hint">按 Esc 也能返回</span>
        </div>
        <nav class="reader-crumbs" aria-label="文档位置">${crumbs}</nav>
        ${meta ? `<p class="reader-meta">${meta}</p>` : ''}
      </div>
      ${toolbar}
      ${tocHtml()}
      ${layout}
      <p class="sr-only" aria-live="polite" data-copy-live></p>
      <div class="reader-manual" data-manual hidden>
        <p class="reader-manual__title">自动复制没有成功，选中下面这段手动复制：</p>
        <textarea class="reader-manual__text" data-manual-text readonly aria-label="要复制的内容"></textarea>
        <button class="btn" type="button" data-manual-close>关闭</button>
      </div>`

    root.classList.toggle('reader--ui', state.font === 'ui')
    if (state.phase === 'ready' && state.toc.length) setupObserver()
    if (state.phase === 'ready') hydrateImages()
  }

  function hydrateImages() {
    if (!IS_MOCK) return
    for (const img of root.querySelectorAll('img[data-raw-src]')) {
      const source = img.dataset.rawSrc
      if (!source) continue
      fetch(source, { credentials: 'same-origin' })
        .then((response) => (response.ok ? response.blob() : null))
        .then((blob) => {
          if (!blob || !state.alive) return
          // The bytes are already here; waiting for a lazy viewport load would leave
          // the image blank in a full-page capture.
          img.loading = 'eager'
          img.src = URL.createObjectURL(blob)
        })
        .catch(() => { /* the alt text stays usable */ })
    }
  }

  /* ---------- events ---------- */

  root.addEventListener('click', (event) => {
    const target = event.target

    const tocButton = target.closest('[data-toc-id]')
    if (tocButton) {
      event.preventDefault()
      const heading = document.getElementById(tocButton.dataset.tocId ?? '')
      if (heading) {
        const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
        setActive(tocButton.dataset.tocId ?? '')
        // A frame later the layout is settled, including a <details> that just opened.
        requestAnimationFrame(() => heading.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' }))
      }
      return
    }

    if (target.closest('[data-copy-all]')) {
      const button = target.closest('[data-copy-all]')
      copyText(state.rawText).then((ok) => {
        if (ok) {
          flashCopied(button)
          announce('已复制全文')
        } else {
          announce('自动复制失败，请手动复制')
        }
      })
      return
    }

    const codeButton = target.closest('[data-copy-code]')
    if (codeButton) {
      const code = codeButton.closest('pre')?.querySelector('code')?.textContent ?? ''
      copyText(code).then((ok) => {
        if (ok) {
          flashCopied(codeButton)
          announce('已复制代码')
        } else {
          announce('自动复制失败，请手动复制')
        }
      })
      return
    }

    if (target.closest('[data-print]')) {
      window.print()
      return
    }

    const fontButton = target.closest('[data-font]')
    if (fontButton) {
      const value = fontButton.dataset.font === 'ui' ? 'ui' : 'read'
      state.font = value
      try { localStorage.setItem(FONT_KEY, value) } catch { /* private mode */ }
      root.classList.toggle('reader--ui', value === 'ui')
      for (const button of root.querySelectorAll('[data-font]')) {
        button.setAttribute('aria-pressed', String(button.dataset.font === value))
      }
      return
    }

    if (target.closest('[data-retry]')) {
      state.phase = 'loading'
      paint()
      load()
      return
    }

    if (target.closest('[data-manual-close]')) {
      const panel = root.querySelector('[data-manual]')
      if (panel) panel.hidden = true
      return
    }
  })

  function onKeydown(event) {
    if (event.key !== 'Escape' || event.defaultPrevented) return
    const tag = document.activeElement?.tagName
    if (tag === 'TEXTAREA' || tag === 'INPUT') return
    event.preventDefault()
    goBack()
  }

  document.addEventListener('keydown', onKeydown)
  paint()
  load()

  return {
    root,
    // Reading must not be interrupted by the shell's 3-second repaint.
    refresh: async () => {},
    destroy() {
      state.alive = false
      state.observer?.disconnect()
      if (state.copiedTimer) clearTimeout(state.copiedTimer)
      document.removeEventListener('keydown', onKeydown)
    },
  }
}
