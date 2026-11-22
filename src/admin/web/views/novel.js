/**
 * 书页：一本书的设定、大纲、章节、人物表；点章节进入正文阅读（#/novels/<id>/<n>）。
 * 路由： #/novels/<id>            书页
 *        #/novels/<id>/<n>        第 n 章正文
 * 3 秒轮询由壳层调用 refresh；这里只每 15 秒真正请求一次。
 */
import { get, post, del, invalidateOverview } from '../lib/api.js'
import { bus } from '../lib/bus.js'
import { esc, money2, emptyHtml, icons } from '../lib/view.js'

const PHASE_LABEL = {
  setup: '准备中',
  drafting: '生成设定中',
  ready: '待开写',
  writing: '写作中',
  paused: '已暂停',
  done: '完结',
  failed: '设定失败',
}
const ARC_LABEL = {
  planned: '未开写',
  pending: '未开写',
  ticketed: '已开票',
  writing: '写作中',
  done: '已完成',
  completed: '已完成',
  committed: '已完成',
}
const KEY_LABEL = {
  name: '名字', role: '身份', realm: '境界', status: '状态', text: '内容', owner: '持有人', id: '编号',
  note: '备注', chapter: '章节', desc: '说明', description: '说明',
}
const CANON_TABLES = [['characters', '人物'], ['foreshadow', '伏笔'], ['items', '物品']]
const OPEN_PHASES = ['ready', 'writing', 'paused']
const REFRESH_MS = 15000
/** One-tap additions to an edit note; the person can still type anything. */
const EDIT_TAGS = ['节奏太拖，压缩', '爽点不够爽，加强铺垫和反应', '对话太平，更有个性', '描写套话多，换具体细节', '字数太少，扩写']

/** Any server value (string, array, object) as one readable line. */
function txt(value) {
  if (value == null) return ''
  if (Array.isArray(value)) return value.map(txt).filter(Boolean).join('；')
  if (typeof value === 'object') return Object.entries(value).map(([key, item]) => `${key}：${txt(item)}`).join('；')
  return String(value)
}

function ticketIdOf(value) {
  if (typeof value === 'string') return value
  return value && typeof value === 'object' ? String(value.id ?? '') : ''
}

function phaseTone(phase) {
  if (phase === 'failed') return 'ask'
  if (phase === 'drafting' || phase === 'writing') return 'run'
  if (phase === 'done') return 'done'
  return 'queue'
}

/** Chapter text is untrusted: every line is escaped; a line starting with "# " is the title. */
function chapterHtml(text) {
  return String(text ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => (/^#\s/.test(line)
      ? `<h2 class="nv-chapter-title">${esc(line.replace(/^#\s+/, ''))}</h2>`
      : `<p>${esc(line)}</p>`))
    .join('')
}

function rowsOf(value) {
  const list = Array.isArray(value) ? value : (value && typeof value === 'object' ? Object.values(value) : [])
  return list.filter((item) => item && typeof item === 'object')
}

export function mount(ctx) {
  const id = String(ctx.params.id ?? '')
  const rawN = ctx.params.n == null ? null : Number(ctx.params.n)
  const chapterN = Number.isInteger(rawN) && rawN > 0 ? rawN : null
  const api = `api/novels/${encodeURIComponent(id)}`
  const root = document.createElement('div')
  root.className = 'page'
  const state = {
    data: null,
    chapter: null,
    canon: null,
    work: null,
    err: '',
    notFound: false,
    arcOpen: false,
    note: '',
    busy: false,
    onlyFlagged: false,
    editOpen: false,
    editNote: '',
  }
  let alive = true
  let lastAt = 0

  async function load() {
    try {
      const data = await get(api)
      if (!alive) return
      state.data = data
      state.notFound = false
      state.err = ''
      if (chapterN != null) {
        state.chapter = await get(`${api}/chapters/${chapterN}`)
      } else {
        const [canon, work] = await Promise.all([
          get(`${api}/canon`).catch(() => null),
          get(`${api}/work`).catch(() => null),
        ])
        state.canon = canon
        state.work = work
      }
    } catch (error) {
      if (!alive || error?.status === 401) return
      if (error?.status === 404 && chapterN == null) state.notFound = true
      else state.err = error?.message || '请求失败'
    }
    lastAt = Date.now()
    if (alive) paint()
  }

  function paint() {
    if (state.notFound) {
      root.innerHTML = `<div class="head"><a class="btn btn--quiet cv-back" href="#/novels">${icons.back} 书库</a></div>${emptyHtml('找不到这本书', '它可能已经被删掉了。', '回到书库', '#/novels')}`
      return
    }
    if (state.err) {
      root.innerHTML = `<div class="banner"><span>这本书没读出来：${esc(state.err)}</span></div>`
      return
    }
    if (!state.data) {
      root.innerHTML = '<p class="hint">正在读这本书…</p>'
      return
    }
    if (chapterN != null) paintChapter()
    else paintBook()
  }

  function arcRow(arc) {
    const label = ARC_LABEL[arc.status] ?? arc.status ?? ''
    const body = arc.outline ?? arc.goal ?? ''
    return `<details class="nv-arc">
      <summary><span class="row__title">第 ${esc(arc.n)} 弧 ${esc(txt(arc.title))}</span>
        <span class="row__meta"><span>${esc(label)}</span><span>${esc(arc.chapters ?? '?')} 章</span></span></summary>
      ${txt(body) ? `<div class="nv-pre">${esc(txt(body))}</div>` : ''}
      ${arc.summary ? `<p class="hint">小结：${esc(txt(arc.summary))}</p>` : ''}
    </details>`
  }

  function chapterRow(chapter) {
    return `<a class="row row--link" href="#/novels/${encodeURIComponent(id)}/${encodeURIComponent(chapter.n)}">
      <span class="row__main"><span class="row__title">第 ${esc(chapter.n)} 章 ${esc(txt(chapter.title))}</span>
        <span class="row__meta"><span>${Number(chapter.chars ?? 0).toLocaleString('zh-CN')} 字</span>${chapter.score != null ? `<span>评分 ${esc(chapter.score)}</span>` : ''}</span></span>
      <span class="row__side">${chapter.status === 'flagged' ? '<span class="nv-flag">待你看</span>' : ''}</span>
    </a>`
  }

  function canonTable(key, label) {
    const items = rowsOf(state.canon?.[key])
    if (!items.length) return ''
    const cols = [...new Set(items.flatMap((item) => Object.keys(item)))].slice(0, 5)
    return `<section class="section"><div class="section__head"><h2 class="section__title">${esc(label)}</h2>
        <span class="section__count">${items.length} 条</span></div>
      <div class="nv-scroll"><table class="nv-table"><thead><tr>${cols.map((col) => `<th>${esc(KEY_LABEL[col] ?? col)}</th>`).join('')}</tr></thead>
      <tbody>${items.map((item) => `<tr>${cols.map((col) => `<td>${esc(txt(item[col]))}</td>`).join('')}</tr>`).join('')}</tbody></table></div></section>`
  }

  function arcFormHtml(next, canOpen) {
    const text = next
      ? `下一弧：第 ${esc(next.n)} 弧《${esc(txt(next.title))}》，约 ${esc(next.chapters ?? '?')} 章`
      : '这本书没有待写的弧了。'
    return `<div class="card nv-arc-form"><p class="hint">${text}</p>
      <div class="field" style="margin-top:8px"><label class="field__label" for="arc-note">要求（可不填）</label>
        <input class="input" id="arc-note" data-arc-note value="${esc(state.note)}" placeholder="例如：这一弧让女主出场"></div>
      <div class="bar-actions" style="margin-top:10px"><button class="btn btn--ink" type="button" data-arc-send ${canOpen && next ? '' : 'disabled'}>开票写下一弧</button></div>
    </div>`
  }

  function paintBook() {
    const d = state.data
    const b = d.book ?? {}
    const plan = d.plan ?? {}
    const volumes = Array.isArray(plan.volumes) ? plan.volumes : []
    const arcs = Array.isArray(plan.arcs) ? plan.arcs : []
    const chapters = rowsOf(d.chapters)
    const bible = d.bible ?? {}
    const gf = bible.goldenFinger ?? {}
    const canOpen = OPEN_PHASES.includes(b.phase)
    const work = state.work
    const beats = Array.isArray(work?.contract?.beats) ? work.contract.beats : []
    const score = work?.review?.score

    root.innerHTML = `
      <div class="head">
        <a class="btn btn--quiet cv-back" href="#/novels">${icons.back} 书库</a>
        <div class="head__row" style="margin-top:10px">
          <h1 class="head__title">${esc(b.title ?? '未命名')}</h1>
          <span class="cv-mode">${esc(b.genreLabel ?? '')}</span>
          <span class="state" data-s="${phaseTone(b.phase)}">${esc(PHASE_LABEL[b.phase] ?? b.phase ?? '')}</span>
        </div>
        ${d.idea ? `<p class="head__sub">${esc(txt(d.idea))}</p>` : ''}
      </div>
      ${b.phase === 'failed' ? `<div class="banner"><span>设定没有生成成功：${esc(b.error ?? '未知原因')}</span></div>` : ''}
      ${b.phase === 'drafting' ? '<div class="banner"><span>正在生成设定，完成后这里会更新。</span></div>' : ''}
      <div class="strip">
        <div class="num"><div class="num__k">写到</div><div class="num__v">第 ${esc(b.lastChapter ?? 0)} 章</div></div>
        <div class="num"><div class="num__k">总字数</div><div class="num__v">${Number(b.chars ?? 0).toLocaleString('zh-CN')}</div></div>
        <div class="num"><div class="num__k">累计成本</div><div class="num__v">${money2(b.costUsd)}</div></div>
        <div class="num"><div class="num__k">待你看</div><div class="num__v">${Number(b.flagged ?? 0)} 章</div></div>
      </div>
      <div class="nv-row-actions">
        <button class="btn btn--ink" type="button" data-arc-open ${canOpen ? '' : 'disabled'}>写下一弧</button>
        ${b.currentTicket ? `<a class="btn" href="#/tickets/${encodeURIComponent(ticketIdOf(b.currentTicket))}">当前工单</a>` : ''}
        <a class="btn" href="api/novels/${encodeURIComponent(id)}/export" download>导出 TXT</a>
        <button class="btn btn--quiet btn--danger" type="button" data-delete>删除</button>
      </div>
      ${state.arcOpen ? arcFormHtml(b.nextArc, canOpen) : ''}
      ${work?.n ? `<section class="section"><div class="section__head"><h2 class="section__title">正在写</h2>
          <span class="section__count">第 ${esc(work.n)} 章</span></div>
        <div class="card">${beats.length
          ? `<ul class="nv-beats">${beats.map((beat) => `<li>${esc(txt(beat))}</li>`).join('')}</ul>`
          : '<p class="hint">这一章的合同还没有写出来。</p>'}
          ${score != null ? `<p class="hint" style="margin-top:8px">最近审稿分：${esc(score)}</p>` : ''}
        </div></section>` : ''}
      <section class="section"><div class="section__head"><h2 class="section__title">设定</h2></div>
        <div class="card">
          ${txt(bible.premise) ? `<p>${esc(txt(bible.premise))}</p>` : '<p class="hint">还没有设定。</p>'}
          ${txt(gf.name) ? `<p style="margin-top:10px"><b>金手指：${esc(txt(gf.name))}</b></p>` : ''}
          ${txt(gf.rules) ? `<p class="hint">规则：${esc(txt(gf.rules))}</p>` : ''}
          ${txt(gf.limits) ? `<p class="hint">限制：${esc(txt(gf.limits))}</p>` : ''}
          ${txt(gf.growth) ? `<p class="hint">成长：${esc(txt(gf.growth))}</p>` : ''}
        </div></section>
      <section class="section"><div class="section__head"><h2 class="section__title">大纲</h2>
          <span class="section__count">${volumes.length} 卷 · ${arcs.length} 弧</span></div>
        ${volumes.length
          ? volumes.map((volume) => `<details class="disclose" open><summary>第 ${esc(volume.n)} 卷 ${esc(txt(volume.title))}</summary>
              ${txt(volume.goal) ? `<p class="hint">${esc(txt(volume.goal))}</p>` : ''}
              <div class="list">${arcs.filter((arc) => arc.volume === volume.n).map(arcRow).join('') || '<p class="hint">这一卷还没有弧。</p>'}</div>
            </details>`).join('')
          : '<p class="hint">还没有大纲。</p>'}
      </section>
      <section class="section"><div class="section__head"><h2 class="section__title">章节</h2>
          <span class="section__count">${chapters.length} 章</span>
          ${Number(b.flagged ?? 0) > 0 ? `<button class="btn btn--quiet ${state.onlyFlagged ? 'btn--ink' : ''}" type="button" data-only-flagged style="margin-left:auto">${state.onlyFlagged ? '显示全部' : `只看待你看（${Number(b.flagged)}）`}</button>` : ''}</div>
        <p class="hint">点任意一章进去阅读；觉得哪章不好，在阅读页底部点「修改这一章」写下意见即可。</p>
        ${chapters.length
          ? `<div class="list">${[...chapters].filter((c) => !state.onlyFlagged || c.status === 'flagged').sort((x, y) => Number(x.n) - Number(y.n)).map(chapterRow).join('')}</div>`
          : '<p class="hint">还没有写出章节。</p>'}
      </section>
      ${CANON_TABLES.map(([key, label]) => canonTable(key, label)).join('')}`
  }

  function paintChapter() {
    const list = rowsOf(state.data.chapters).map((chapter) => Number(chapter.n)).sort((x, y) => x - y)
    const index = list.indexOf(chapterN)
    const prev = index > 0 ? list[index - 1] : null
    const next = index >= 0 && index < list.length - 1 ? list[index + 1] : null
    const link = (n, label) => (n == null
      ? '<span></span>'
      : `<a class="btn btn--quiet" href="#/novels/${encodeURIComponent(id)}/${n}">${label}</a>`)
    const nav = `<nav class="nv-chnav">${link(prev, '‹ 上一章')}${link(next, '下一章 ›')}</nav>`
    const chapter = state.chapter ?? {}
    const notes = Array.isArray(chapter.notes) ? chapter.notes : []
    const flagged = chapter.row?.status === 'flagged'
    const edit = chapter.edit
    const running = edit?.status === 'running'
    const editStatus = !edit ? ''
      : running ? `<div class="banner"><span>正在按你的意见修改：「${esc(edit.note)}」。改完会自动刷新，大约几分钟。</span></div>`
      : edit.status === 'done' ? `<div class="card"><p class="hint">上次按「${esc(edit.note)}」改过，正文已是新版。</p>
          <div class="bar-actions" style="margin-top:8px"><button class="btn" type="button" data-edit-undo>撤销这次修改</button></div></div>`
      : edit.status === 'failed' ? `<div class="banner"><span>上次修改没成功，原稿没有动：${esc(edit.error ?? '')}</span></div>`
      : ''
    const editForm = state.editOpen ? `<div class="card nv-arc-form">
        <div class="field"><label class="field__label" for="edit-note">这一章哪里不好，要怎么改？</label>
          <textarea class="textarea" rows="4" id="edit-note" data-edit-note placeholder="例如：打斗太拖沓，压缩到三五个回合；姚伯的台词再硬一点">${esc(state.editNote)}</textarea></div>
        <div class="bar-actions" style="margin-top:6px">${EDIT_TAGS.map((tag) => `<button class="btn btn--quiet" type="button" data-edit-tag="${esc(tag)}">${esc(tag)}</button>`).join('')}</div>
        <p class="hint" style="margin-top:6px">只改这一章的写法，出场人物、得失、境界、伏笔这些事实保持不变，所以后面的章节不受影响。原稿会保留，改完不满意可以撤销。</p>
        <div class="bar-actions" style="margin-top:10px">
          <button class="btn btn--ink" type="button" data-edit-send ${state.busy ? 'disabled' : ''}>按意见修改</button>
          <button class="btn btn--quiet" type="button" data-edit-close>取消</button>
        </div></div>` : ''
    const actions = `<div class="nv-row-actions">
        <button class="btn btn--ink" type="button" data-edit-open ${running ? 'disabled' : ''}>修改这一章</button>
        ${flagged ? '<button class="btn" type="button" data-mark-read>看过了，没问题</button>' : ''}
      </div>`
    root.innerHTML = `
      <div class="head"><a class="btn btn--quiet cv-back" href="#/novels/${encodeURIComponent(id)}">${icons.back} 书页</a>
        ${flagged ? '<span class="nv-flag" style="margin-left:8px">待你看</span>' : ''}</div>
      ${flagged && notes.length ? `<div class="banner"><span>标成待你看的原因：${esc(notes.map(txt).join('；'))}</span></div>` : ''}
      ${editStatus}
      ${nav}
      <article class="nv-text">${chapterHtml(chapter.text)}</article>
      ${nav}
      ${actions}
      ${editForm}
      ${!flagged && notes.length ? `<section class="section"><div class="section__head"><h2 class="section__title">审稿记录</h2></div>
        <ul class="nv-beats">${notes.map((note) => `<li>${esc(txt(note))}</li>`).join('')}</ul></section>` : ''}`
  }

  async function chapterAction(action, body) {
    if (state.busy) return
    state.busy = true
    try {
      await post(`${api}/chapters/${chapterN}/${action}`, body ?? {})
      if (action === 'edit') { state.editOpen = false; state.editNote = ''; bus.toast('已提交修改意见，改完自动刷新') }
      if (action === 'undo') bus.toast('已撤销，正文恢复为修改前')
      if (action === 'read') bus.toast('已标为看过')
      await load()
    } catch (error) {
      bus.toast(error?.message || '没有成功，可以再试。', { danger: true })
    } finally {
      state.busy = false
      paint()
    }
  }

  async function sendArc() {
    if (state.busy) return
    state.busy = true
    const note = String(state.note ?? '').trim()
    try {
      const result = await post(`${api}/arcs`, note ? { note } : {})
      state.arcOpen = false
      state.note = ''
      invalidateOverview()
      if (result?.ticketId) {
        bus.toast('已开票，开始写下一弧')
        bus.navigate(`tickets/${encodeURIComponent(result.ticketId)}`)
        return
      }
      bus.toast('下一弧已排上')
      await load()
    } catch (error) {
      bus.toast(error?.message || '没有开票，可以再试。', { danger: true })
    } finally {
      state.busy = false
    }
  }

  async function removeBook() {
    const confirmed = await bus.sheet({
      title: '删除这本书？',
      text: '书稿、设定和章节都会删掉，删了就不能恢复。',
      confirmLabel: '删除',
      danger: true,
    })
    if (!confirmed) return
    try {
      await del(api)
      invalidateOverview()
      bus.toast('已删除这本书')
      bus.navigate('novels')
    } catch (error) {
      bus.toast(error?.message || '没有删掉，可以再试。', { danger: true })
    }
  }

  root.addEventListener('click', async (event) => {
    const target = event.target
    if (target.closest('[data-arc-open]')) {
      state.arcOpen = !state.arcOpen
      paint()
      return
    }
    if (target.closest('[data-arc-send]')) {
      await sendArc()
      return
    }
    if (target.closest('[data-only-flagged]')) { state.onlyFlagged = !state.onlyFlagged; paint(); return }
    if (target.closest('[data-edit-open]')) { state.editOpen = true; paint(); root.querySelector('[data-edit-note]')?.focus(); return }
    if (target.closest('[data-edit-close]')) { state.editOpen = false; paint(); return }
    const tag = target.closest('[data-edit-tag]')
    if (tag) {
      const add = tag.dataset.editTag
      state.editNote = state.editNote.trim() ? `${state.editNote.trim()}；${add}` : add
      paint()
      return
    }
    if (target.closest('[data-edit-send]')) {
      const note = state.editNote.trim()
      if (!note) { bus.toast('先写一句要怎么改', { danger: true }); return }
      await chapterAction('edit', { note })
      return
    }
    if (target.closest('[data-edit-undo]')) {
      const ok = await bus.sheet({ title: '撤销这次修改？', text: '正文会恢复成修改前的版本。', confirmLabel: '撤销' })
      if (ok) await chapterAction('undo')
      return
    }
    if (target.closest('[data-mark-read]')) { await chapterAction('read'); return }
    if (target.closest('[data-delete]')) await removeBook()
  })

  root.addEventListener('input', (event) => {
    if (event.target.matches('[data-arc-note]')) state.note = event.target.value
    if (event.target.matches('[data-edit-note]')) state.editNote = event.target.value
  })

  load()
  return {
    root,
    refresh: async () => {
      // Faster while an edit runs; never repaint over a half-written edit note.
      const wait = state.chapter?.edit?.status === 'running' ? 5000 : REFRESH_MS
      if (state.editOpen || Date.now() - lastAt < wait) return
      await load()
    },
    destroy() {
      alive = false
    },
  }
}
