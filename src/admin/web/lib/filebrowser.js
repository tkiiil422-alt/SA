/**
 * A small read-only file browser shared by project details (and, later, ticket
 * workspaces). It talks to the admin `files` endpoint:
 *
 *   GET <filesUrl>?path=<relative path>
 *     directory -> { exists, type:'dir', path, name, entries:[{name,type,size?}] }
 *     text file -> { exists, type:'file', path, name, size, modifiedAt, text, truncated }
 *     binary    -> { exists, type:'file', path, name, size, modifiedAt, binary:true }
 *     image raw -> ?path=…&raw=1 (image bytes)
 *     download  -> ?path=…&download=1 (attachment)
 *
 * The module never assumes a project: pass the endpoint and the reader link.
 */
import { get } from './api.js'
import { esc, icons } from './view.js'
import { bytes, absTime } from './format.js'

const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif'])

function extensionOf(name) {
  const index = String(name).lastIndexOf('.')
  if (index <= 0 || index === String(name).length - 1) return ''
  return String(name).slice(index + 1).toLowerCase()
}

function joinPath(parent, name) {
  return [parent, name].filter(Boolean).join('/')
}

function parentOf(path) {
  return String(path).split('/').filter(Boolean).slice(0, -1).join('/')
}

/** Build an endpoint with the optional query parameters the API understands. */
function endpoint(filesUrl, path, extra = {}) {
  const base = String(filesUrl).replace(/\?.*$/, '')
  const query = new URLSearchParams()
  if (path) query.set('path', path)
  for (const [key, value] of Object.entries(extra)) {
    if (value) query.set(key, '1')
  }
  const text = query.toString()
  return text ? `${base}?${text}` : base
}

/**
 * @param {object} options
 * @param {string} options.filesUrl   e.g. "api/projects/p_x/files"
 * @param {(path: string) => string} options.docHref  reader link for Markdown files
 * @param {string} options.keepKey    inner scroll key; also the module's own state key
 * @param {string} [options.rootLabel]
 */
export function createFileBrowser({ filesUrl, docHref, keepKey, rootLabel = '根目录' }) {
  const root = document.createElement('div')
  root.className = 'fb'
  root.dataset.fbRoot = keepKey || 'files'
  root.innerHTML = `
    <div class="fb__bar">
      <nav class="fb__crumbs" data-fb-crumbs aria-label="文件路径"></nav>
      <button class="fb__up" type="button" data-fb-up hidden>上一级</button>
    </div>
    <div class="fb__body" data-fb-body data-keep-scroll="${esc(keepKey || 'files')}">
      <p class="hint">正在读文件…</p>
    </div>`

  const crumbsHost = root.querySelector('[data-fb-crumbs]')
  const body = root.querySelector('[data-fb-body]')
  const upButton = root.querySelector('[data-fb-up]')
  let alive = true
  let seq = 0
  const state = { path: '', file: null }

  function crumbsHtml() {
    const parts = state.path.split('/').filter(Boolean)
    const items = [`<a class="fb__crumb" href="#" data-fb-dir="">${esc(rootLabel)}</a>`]
    let accumulated = ''
    for (const part of parts) {
      accumulated = joinPath(accumulated, part)
      items.push(`<span class="fb__sep" aria-hidden="true">/</span><a class="fb__crumb" href="#" data-fb-dir="${esc(accumulated)}">${esc(part)}</a>`)
    }
    return items.join('')
  }

  function renderCrumbs() {
    crumbsHost.innerHTML = crumbsHtml()
    upButton.hidden = state.path === ''
    upButton.dataset.fbDir = parentOf(state.path)
  }

  function kindLabel(type) {
    return type === 'dir' ? '目录' : '文件'
  }

  function renderDir(data) {
    state.file = null
    renderCrumbs()
    const entries = Array.isArray(data?.entries) ? data.entries : []
    if (!data?.exists) {
      body.innerHTML = '<p class="hint">这个位置不存在，可能已经被删掉了。</p>'
      return
    }
    if (!entries.length) {
      body.innerHTML = '<p class="hint">这个文件夹是空的。</p>'
      return
    }
    body.innerHTML = `<ul class="fb__list">
      ${entries.map((entry) => {
        const path = joinPath(state.path, entry.name)
        const attribute = entry.type === 'dir' ? 'data-fb-dir' : 'data-fb-file'
        return `<li><button class="fb__row" type="button" ${attribute}="${esc(path)}">
          <span class="fb__kind" data-kind="${entry.type === 'dir' ? 'dir' : 'file'}" aria-hidden="true"></span>
          <span class="fb__name">${esc(entry.name)}</span>
          <span class="fb__meta">${entry.type === 'dir' ? '目录' : bytes(entry.size ?? 0)}</span>
        </button></li>`
      }).join('')}
    </ul>`
  }

  function renderFile(data) {
    renderCrumbs()
    const path = data?.path ?? state.path
    const ext = extensionOf(data?.name ?? path)
    const image = IMAGE_EXT.has(ext)
    const rawUrl = endpoint(filesUrl, path, { raw: true })
    const downloadUrl = endpoint(filesUrl, path, { download: true })
    const readLink = ext === 'md' && typeof docHref === 'function'
      ? `<a class="btn btn--quiet" href="${esc(docHref(path))}">阅读</a>`
      : ''
    let content
    if (image) {
      content = `<img class="fb__image" src="${esc(rawUrl)}" alt="${esc(data?.name ?? '')}">`
    } else if (data?.binary) {
      content = '<p class="hint">这是二进制文件，不能在线预览。可以下载到本地再看。</p>'
    } else if (typeof data?.text === 'string') {
      content = `<pre class="fb__code">${esc(data.text)}</pre>${data.truncated ? '<p class="hint">文件太大，只显示了开头一段。</p>' : ''}`
    } else {
      content = '<p class="hint">读不到这个文件的内容。</p>'
    }
    body.innerHTML = `<div class="fb__view">
      <div class="fb__viewhead">
        <span class="fb__viewname mono">${esc(path || data?.name || '')}</span>
        <span class="hint">${bytes(data?.size ?? 0)}${data?.modifiedAt ? `，${esc(absTime(data.modifiedAt))}` : ''}</span>
        <span class="fb__viewacts">
          ${readLink}
          <a class="btn btn--quiet" href="${esc(downloadUrl)}" download>下载</a>
          <button class="btn btn--quiet" type="button" data-fb-dir="${esc(parentOf(path))}">${icons.back}<span>返回</span></button>
        </span>
      </div>
      ${content}
    </div>`
  }

  async function loadDir(path) {
    const run = ++seq
    state.path = path
    state.file = null
    renderCrumbs()
    body.innerHTML = '<p class="hint">正在读文件…</p>'
    try {
      const data = await get(endpoint(filesUrl, path))
      if (!alive || run !== seq) return
      renderDir(data)
    } catch (error) {
      if (!alive || run !== seq) return
      body.innerHTML = `<p class="hint">读不到这个文件夹：${esc(error?.message || '请求失败')}</p>`
    }
  }

  async function loadFile(path) {
    const run = ++seq
    state.path = path
    body.innerHTML = '<p class="hint">正在读文件…</p>'
    try {
      const data = await get(endpoint(filesUrl, path))
      if (!alive || run !== seq) return
      if (!data || data.type !== 'file') {
        body.innerHTML = '<p class="hint">这个位置不是文件，可能已经被删掉了。</p>'
        return
      }
      state.file = path
      renderFile(data)
    } catch (error) {
      if (!alive || run !== seq) return
      body.innerHTML = `<p class="hint">读不到这个文件：${esc(error?.message || '请求失败')}</p>`
    }
  }

  root.addEventListener('click', (event) => {
    const dir = event.target.closest('[data-fb-dir]')
    if (dir) {
      event.preventDefault()
      void loadDir(dir.dataset.fbDir || '')
      return
    }
    const file = event.target.closest('[data-fb-file]')
    if (file) {
      event.preventDefault()
      void loadFile(file.dataset.fbFile || '')
    }
  })

  void loadDir('')

  return {
    root,
    /** Re-read the current folder or file (used by the shell's polling refresh). */
    refresh: async () => {
      if (state.file) await loadFile(state.file)
      else await loadDir(state.path)
    },
    destroy() {
      alive = false
      seq += 1
    },
  }
}
