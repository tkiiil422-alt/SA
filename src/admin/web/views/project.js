/**
 * 项目详情：档案、目录树、文件浏览，以及用这个项目开任务 / 删除。
 *
 * The top block (status and actions) is updated on every poll; the ready-only
 * content is built once so the embedded file browser keeps its current folder.
 */
import { get, del } from '../lib/api.js'
import { bus } from '../lib/bus.js'
import { esc, ago } from '../lib/view.js'
import { bytes } from '../lib/format.js'
import { renderMarkdown } from '../lib/markdown.js'
import { createFileBrowser } from '../lib/filebrowser.js'

const LANGUAGE_NAMES = {
  ts: 'TypeScript', tsx: 'TypeScript', js: 'JavaScript', jsx: 'JavaScript', mjs: 'JavaScript', cjs: 'JavaScript',
  py: 'Python', go: 'Go', rs: 'Rust', java: 'Java', kt: 'Kotlin', c: 'C', h: 'C', cpp: 'C++', cc: 'C++', hpp: 'C++',
  cs: 'C#', rb: 'Ruby', php: 'PHP', swift: 'Swift', dart: 'Dart', lua: 'Lua', sh: 'Shell', ps1: 'PowerShell',
  md: 'Markdown', json: 'JSON', yml: 'YAML', yaml: 'YAML', toml: 'TOML', xml: 'XML', html: 'HTML', css: 'CSS',
  scss: 'SCSS', less: 'Less', sql: 'SQL', vue: 'Vue', svelte: 'Svelte',
}

function langName(ext) {
  return LANGUAGE_NAMES[String(ext).toLowerCase()] ?? String(ext || '其它')
}

function statusHtml(detail) {
  if (detail.status === 'extracting') {
    const done = Number(detail.progress?.done) || 0
    const total = Number(detail.progress?.total) || 0
    const pct = total > 0 ? Math.max(0, Math.min(100, Math.round((done / total) * 100))) : 0
    return `<div class="pstatusblock">
      <span class="pstat" data-s="extracting"><i class="pstat__mark" aria-hidden="true"></i>解压中</span>
      <span class="upbar upbar--slim" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}"><i style="width:${pct}%"></i></span>
      <span class="hint">${total > 0 ? `${done.toLocaleString('en-US')} / ${total.toLocaleString('en-US')} 个文件` : '正在准备文件'}</span>
    </div>`
  }
  if (detail.status === 'failed') {
    return '<span class="pstat" data-s="failed"><i class="pstat__mark" aria-hidden="true"></i>失败</span>'
  }
  if (detail.status === 'uploading') {
    return '<span class="pstat" data-s="uploading"><i class="pstat__mark" aria-hidden="true"></i>上传中</span>'
  }
  return '<span class="pstat" data-s="ready"><i class="pstat__mark" aria-hidden="true"></i>可用</span>'
}

function actionsHtml(detail) {
  const deleteButton = '<button class="btn btn--danger" type="button" data-delete>删除项目</button>'
  if (detail.status === 'ready') {
    return `<button class="btn btn--ink" type="button" data-open>用这个项目开任务</button>${deleteButton}`
  }
  if (detail.status === 'failed') {
    return '<button class="btn btn--danger" type="button" data-delete>删除后重新上传</button>'
  }
  return deleteButton
}

function languagesHtml(languages) {
  const list = Array.isArray(languages) ? languages.filter((item) => Number(item.files) > 0) : []
  if (!list.length) return '<p class="hint">档案里没有识别到语言构成。</p>'
  const top = list.slice(0, 5)
  const total = list.reduce((sum, item) => sum + Number(item.files || 0), 0)
  // The bar shows every recognised language so it reaches 100%; the text list stays at five.
  const bar = list.map((item, index) => {
    const pct = total > 0 ? (Number(item.files) / total) * 100 : 0
    return `<i data-i="${index % 5}" style="width:${pct.toFixed(2)}%" title="${esc(langName(item.ext))} ${pct.toFixed(1)}%"></i>`
  }).join('')
  const legend = top.map((item, index) => {
    const pct = total > 0 ? (Number(item.files) / total) * 100 : 0
    return `<li><span class="lang__mark" data-i="${index}" aria-hidden="true"></span>
      <span class="lang__name">${esc(langName(item.ext))}</span>
      <span class="hint">${Number(item.files).toLocaleString('en-US')} 个文件，${pct.toFixed(0)}%</span></li>`
  }).join('')
  return `<div class="langbar" aria-hidden="true">${bar}</div>
    <ul class="langlist">${legend}</ul>`
}

function manifestsHtml(manifests) {
  const list = Array.isArray(manifests) ? manifests : []
  if (!list.length) return '<p class="hint">没有找到 package.json、pyproject.toml、go.mod 这类清单。</p>'
  return list.map((item) => `<div class="manifest">
    <div class="manifest__file mono">${esc(item.file)}</div>
    <pre class="manifest__summary">${esc(item.summary)}</pre>
  </div>`).join('')
}

function gitHtml(git) {
  if (!git) return '<p class="hint">项目里没有可读的 Git 信息。</p>'
  const branch = git.branch ? `<span class="mono">${esc(git.branch)}</span>` : '<span class="hint">分支未知</span>'
  const recent = Array.isArray(git.recent) ? git.recent : []
  return `<p class="git__branch">当前分支 ${branch}</p>
    ${recent.length ? `<ul class="git__commits">
      ${recent.map((item) => `<li><span class="mono">${esc(item.hash7 || '')}</span><span>${esc(item.message || '')}</span></li>`).join('')}
    </ul>` : '<p class="hint">没有读到最近的提交记录。</p>'}`
}

function buildTree(paths) {
  const root = { dirs: new Map(), files: [] }
  for (const raw of Array.isArray(paths) ? paths : []) {
    const text = String(raw || '')
    if (!text) continue
    const isDir = text.endsWith('/')
    const parts = text.replace(/\/$/, '').split('/').filter(Boolean)
    let node = root
    for (let index = 0; index < parts.length; index += 1) {
      const name = parts[index]
      const last = index === parts.length - 1
      if (last && !isDir) {
        if (!node.files.includes(name)) node.files.push(name)
        break
      }
      if (!node.dirs.has(name)) node.dirs.set(name, { dirs: new Map(), files: [] })
      node = node.dirs.get(name)
    }
  }
  return root
}

function treeHtml(node) {
  const dirs = [...node.dirs.entries()]
  if (!dirs.length && !node.files.length) return '<p class="hint">档案里没有目录信息。</p>'
  const directoryItems = dirs.map(([name, child]) => {
    const inner = child.dirs.size || child.files.length ? `<ul>${treeListHtml(child)}</ul>` : ''
    return `<li class="ptree__dir"><span class="ptree__name">${esc(name)}/</span>${inner}</li>`
  }).join('')
  const fileItems = node.files.map((name) => `<li class="ptree__file">${esc(name)}</li>`).join('')
  return `<ul class="ptree">${directoryItems}${fileItems}</ul>`
}

function treeListHtml(node) {
  const dirs = [...node.dirs.entries()].map(([name, child]) => {
    const inner = child.dirs.size || child.files.length ? `<ul>${treeListHtml(child)}</ul>` : ''
    return `<li class="ptree__dir"><span class="ptree__name">${esc(name)}/</span>${inner}</li>`
  }).join('')
  const files = node.files.map((name) => `<li class="ptree__file">${esc(name)}</li>`).join('')
  return dirs + files
}

function warningsHtml(warnings) {
  if (!Array.isArray(warnings) || !warnings.length) return ''
  return `<details class="warnings" data-keep="project.warnings">
    <summary>上传与解压提醒（${warnings.length} 条）</summary>
    <ul>${warnings.map((item) => `<li>${esc(item)}</li>`).join('')}</ul>
  </details>`
}

export function mount(ctx) {
  const id = String(ctx?.params?.id ?? '')
  const root = document.createElement('div')
  root.className = 'page project-page'
  root.innerHTML = `
    <div class="head">
      <div class="head__row">
        <a class="backlink" href="#/projects">← 项目</a>
        <h1 class="head__title" data-title>项目详情</h1>
      </div>
      <p class="head__sub" data-sub>正在读项目…</p>
      <div class="project-status" data-status></div>
      <div class="project-actions" data-actions></div>
    </div>
    <div data-content><p class="hint">正在读项目…</p></div>`

  const titleHost = root.querySelector('[data-title]')
  const subHost = root.querySelector('[data-sub]')
  const statusHost = root.querySelector('[data-status]')
  const actionsHost = root.querySelector('[data-actions]')
  const contentHost = root.querySelector('[data-content]')
  let alive = true
  let detail = null
  let renderedReady = false
  let browser = null
  let warningsJson = ''
  let deleting = false

  function renderStatus(next) {
    titleHost.textContent = next.name || '项目详情'
    const files = Number(next.files ?? 0).toLocaleString('en-US')
    subHost.textContent = `${files} 个文件，${bytes(next.bytes ?? 0)}，${ago(next.createdAt)}上传` +
      (next.sourceName ? `，来自 ${next.sourceName}` : '')
    statusHost.innerHTML = statusHtml(next)
    actionsHost.innerHTML = actionsHtml(next)
  }

  function renderNotReady(next) {
    if (next.status === 'failed') {
      contentHost.innerHTML = `<div class="project-fail">
        <p class="project-fail__reason">${esc(next.error || '这个项目没有准备好。')}</p>
        <p class="hint">可以删除它，再重新上传。</p>
      </div>`
      return
    }
    if (next.status === 'extracting') {
      contentHost.innerHTML = `<p class="hint">正在解压。完成后这里会出现项目档案、目录和文件浏览。</p>`
      return
    }
    contentHost.innerHTML = '<p class="hint">这个项目还没准备好。</p>'
  }

  function renderReady(next) {
    const profile = next.profile
    contentHost.innerHTML = `
      <section class="section">
        <div class="section__head"><h2 class="section__title">档案</h2></div>
        ${profile
          ? `<div class="profile">
              <div class="profile__block">
                <h3 class="profile__k">语言构成</h3>
                ${languagesHtml(profile.languages)}
              </div>
              <div class="profile__block">
                <h3 class="profile__k">README 节选</h3>
                ${profile.readme
                  ? `<div class="read project-readme">${renderMarkdown(profile.readme)}</div>`
                  : '<p class="hint">没有找到 README。</p>'}
              </div>
              <div class="profile__block">
                <h3 class="profile__k">项目清单</h3>
                ${manifestsHtml(profile.manifests)}
              </div>
              <div class="profile__block">
                <h3 class="profile__k">Git</h3>
                ${gitHtml(profile.git)}
              </div>
            </div>`
          : '<p class="hint">这个项目没有生成档案，但文件仍然可以浏览。</p>'}
      </section>
      <section class="section">
        <div class="section__head"><h2 class="section__title">目录</h2><span class="section__note">只显示前两层</span></div>
        <div class="ptree-host">${treeHtml(buildTree(profile?.topLevel ?? []))}</div>
      </section>
      <section class="section">
        <div class="section__head"><h2 class="section__title">文件</h2><span class="section__note">只读；点 .md 可以进阅读器</span></div>
        <div data-files></div>
      </section>
      <section class="section" data-warnings>${warningsHtml(next.warnings)}</section>`
    warningsJson = JSON.stringify(next.warnings ?? [])
    const host = contentHost.querySelector('[data-files]')
    if (host) {
      try {
        browser = createFileBrowser({
          filesUrl: `api/projects/${encodeURIComponent(id)}/files`,
          docHref: (path) => `#/doc/project/${encodeURIComponent(id)}?path=${encodeURIComponent(path)}`,
          keepKey: 'project.files',
          rootLabel: '项目根',
        })
        host.append(browser.root)
      } catch (error) {
        host.innerHTML = `<p class="hint">文件浏览没能打开：${esc(error?.message || '未知错误')}</p>`
      }
    }
  }

  function renderWarningsOnly(next) {
    const nextJson = JSON.stringify(next.warnings ?? [])
    if (nextJson === warningsJson) return
    warningsJson = nextJson
    const host = contentHost.querySelector('[data-warnings]')
    if (host) host.innerHTML = warningsHtml(next.warnings)
  }

  function renderNotFound() {
    titleHost.textContent = '找不到这个项目'
    subHost.textContent = '它可能已经被删掉了。'
    statusHost.innerHTML = ''
    actionsHost.innerHTML = ''
    contentHost.innerHTML = '<div class="empty"><p class="empty__title">这个项目不在了</p><p class="empty__text">回到项目列表看看还有哪些项目。</p><a class="btn btn--quiet" href="#/projects">回项目列表</a></div>'
  }

  function apply(next) {
    detail = next
    if (!next) {
      browser?.destroy()
      browser = null
      renderedReady = false
      renderNotFound()
      return
    }
    renderStatus(next)
    if (next.status === 'ready') {
      if (!renderedReady) {
        renderReady(next)
        renderedReady = true
      } else {
        renderWarningsOnly(next)
      }
    } else {
      if (renderedReady) {
        browser?.destroy()
        browser = null
        renderedReady = false
      }
      renderNotReady(next)
    }
  }

  async function refresh() {
    try {
      const next = await get(`api/projects/${encodeURIComponent(id)}`)
      if (!alive) return
      apply(next)
    } catch (error) {
      if (!alive) return
      if (error?.status === 404) {
        apply(null)
        return
      }
      if (!detail) {
        contentHost.innerHTML = `<p class="hint">读不到这个项目：${esc(error?.message || '请求失败')}</p>`
      }
    }
  }

  async function removeProject() {
    if (deleting) return
    const answer = await bus.sheet({
      title: '删除这个项目？',
      text: '项目文件和档案都会删掉。已开的任务有自己的副本，不受影响。',
      confirmLabel: '删除项目',
      danger: true,
    })
    if (answer === null) return
    deleting = true
    try {
      await del(`api/projects/${encodeURIComponent(id)}`)
      bus.toast('项目已删除')
      ctx.navigate('projects')
    } catch (error) {
      bus.toast(error?.message || '没有删掉，请重试。', { danger: true })
    } finally {
      deleting = false
    }
  }

  root.addEventListener('click', (event) => {
    if (event.target.closest('[data-open]')) {
      bus.openCompose({ projectId: id })
      return
    }
    if (event.target.closest('[data-delete]')) {
      void removeProject()
    }
  })

  void refresh()

  return {
    root,
    refresh: async () => {
      await refresh()
      if (renderedReady) await browser?.refresh?.()
    },
    destroy() {
      alive = false
      browser?.destroy()
      browser = null
    },
  }
}
