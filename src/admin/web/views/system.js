/** 系统: health, the pause switch, backups, orphans, and cleaning old workspaces. */
import { get, post, invalidateOverview } from '../lib/api.js'
import { bus } from '../lib/bus.js'
import { esc, ago } from '../lib/view.js'
import { bytes, duration, absTime } from '../lib/format.js'

export function mount(ctx) {
  const root = document.createElement('div')
  root.className = 'page'
  let alive = true
  const state = {
    data: null,
    cleanup: null,
    backups: null,
    orphans: null,
    orphanSelected: new Set(),
    confirmOpen: false,
    busy: false,
    backupBusy: false,
  }

  const render = async () => {
    try {
      const [data, backups, orphans] = await Promise.all([
        get('api/system'),
        get('api/system/backups'),
        get('api/system/orphans'),
      ])
      if (!alive) return
      state.data = data
      state.backups = backups
      state.orphans = orphans
      const ids = new Set((Array.isArray(orphans?.items) ? orphans.items : []).map((item) => String(item.id)))
      for (const id of [...state.orphanSelected]) {
        if (!ids.has(id)) state.orphanSelected.delete(id)
      }
    } catch (error) {
      if (error?.status === 401) return
      root.innerHTML = `<div class="banner"><span>系统状态没有读出来：${esc(error?.message || '请求失败')}</span></div>`
      return
    }
    paint()
  }

  function orphanSelection() {
    const orphans = Array.isArray(state.orphans?.items) ? state.orphans.items : []
    const selected = orphans.filter((item) => state.orphanSelected.has(String(item.id)))
    return {
      orphans,
      selected,
      selectedBytes: selected.reduce((sum, item) => sum + Number(item.bytes ?? 0), 0),
    }
  }

  function backupCard() {
    const items = Array.isArray(state.backups?.items) ? state.backups.items : []
    const dir = state.backups?.dir ?? ''
    return `
      <section class="section">
        <div class="section__head"><h2 class="section__title">备份</h2><span class="section__note">${items.length} 份</span></div>
        <div class="sys-block">
          <div class="backup__head">
            <span class="backup__dir mono">${esc(dir || '还没有设置备份目录')}</span>
            <button class="btn" type="button" data-backup-now ${state.backupBusy ? 'disabled' : ''}>${state.backupBusy ? '正在备份…' : '立即备份'}</button>
          </div>
          ${items.length ? `<ul class="backups">
            ${items.map((item) => `<li class="backup">
              <span class="backup__name">${esc(item.name)}</span>
              <span class="backup__meta"><span title="${esc(absTime(item.at))}">${esc(ago(item.at))}</span><span>${bytes(item.bytes)}</span></span>
            </li>`).join('')}
          </ul>` : '<p class="hint" style="margin-top:8px">还没有备份。</p>'}
          <p class="hint" style="margin-top:10px">每天自动备份一次，保留最近 7 份。恢复需要在主机上停服务后解压，见部署文档。</p>
        </div>
      </section>`
  }

  function orphanCard() {
    const { orphans, selected, selectedBytes } = orphanSelection()
    const totalBytes = Number(state.orphans?.totalBytes
      ?? orphans.reduce((sum, item) => sum + Number(item.bytes ?? 0), 0))
    return `
      <section class="section">
        <div class="section__head"><h2 class="section__title">没有对应任务的文件</h2><span class="section__note">共 ${bytes(totalBytes)}</span></div>
        <div class="sys-block">
          ${orphans.length ? `
            <ul class="orphans">
              ${orphans.map((item) => {
                const id = String(item.id)
                const picked = state.orphanSelected.has(id)
                const kind = item.kind === 'pi-config' ? 'AI 配置' : '工作区'
                return `<li class="orphan${picked ? ' row--picked' : ''}">
                  <input class="pick" type="checkbox" data-orphan="${esc(id)}" ${picked ? 'checked' : ''} aria-label="选择 ${esc(item.path)}">
                  <span class="orphan__body">
                    <span class="orphan__path mono">${esc(item.path)}</span>
                    <span class="orphan__meta"><span class="tag">${kind}</span><span>${bytes(item.bytes)}</span></span>
                  </span>
                </li>`
              }).join('')}
            </ul>
            <div class="orphan__actions">
              <span class="hint" data-orphan-count>已选 ${selected.length} 个，共 ${bytes(selectedBytes)}</span>
              <button class="btn btn--danger" type="button" data-orphan-clean ${selected.length ? '' : 'disabled'}>清理选中</button>
            </div>
            ${state.confirmOpen ? `<div class="confirm confirm--inline">
              <p class="confirm__text" data-orphan-confirm-text>会删除选中的 ${selected.length} 个文件，共 ${bytes(selectedBytes)}。删掉后找不回来。</p>
              <div class="bar-actions">
                <button class="btn" type="button" data-orphan-cancel>再想想</button>
                <button class="btn btn--danger" type="button" data-orphan-confirm ${state.busy || !selected.length ? 'disabled' : ''}>确认清理</button>
              </div>
            </div>` : ''}
          ` : '<p class="hint">没有多余文件</p>'}
        </div>
      </section>`
  }

  function paint() {
    const info = state.data ?? {}
    const disk = info.disk ?? {}
    const containers = Array.isArray(info.containers) ? info.containers : []
    const paused = ctx.overview?.()?.paused === true
    const freeGbRaw = disk.freeGb
    const freeGb = Number.isFinite(Number(freeGbRaw)) && freeGbRaw !== null && freeGbRaw !== undefined ? Number(freeGbRaw) : null
    const diskTone = freeGb !== null && freeGb < 10 ? 'style="color:var(--human);font-weight:600"' : ''
    const cleanup = state.cleanup

    root.innerHTML = `
      <div class="head">
        <div class="head__row"><h1 class="head__title">系统</h1></div>
        <p class="head__sub">版本 ${esc(info.version ?? '—')}，已运行 ${esc(duration(info.uptimeSec))}，最多同时跑 ${info.limits?.maxWorkers ?? '—'} 个任务</p>
      </div>

      <div class="switchline" style="border-bottom:1px solid var(--line)">
        <span class="switchline__text">
          <span class="switchline__title">暂停接新任务</span>
          <span class="switchline__desc">新请求会排队，正在跑的不受影响；恢复后按顺序继续</span>
        </span>
        <button class="switch" type="button" role="switch" aria-checked="${paused}" data-pause><span class="switch__track"><i></i></span></button>
      </div>

      <div class="list" style="margin-top:6px">
        <div class="row"><span class="row__main"><span class="row__title"><span class="lamp">守护进程</span></span>
          <span class="row__meta"><span>已运行 ${esc(duration(info.uptimeSec))}</span><span>版本 ${esc(info.version ?? '—')}</span></span></span>
          <span class="row__side state" data-s="run">正常</span></div>
        ${containers.length ? containers.map((container) => `<div class="row">
          <span class="row__main"><span class="row__title">容器 ${esc(container.name)}</span>
            <span class="row__meta"><span>${esc(container.status || '—')}</span><span>对应 ${esc(container.ticketId || '—')}</span></span></span>
          <span class="row__side state" data-s="run">在跑</span></div>`).join('')
          : '<div class="row"><span class="row__main"><span class="row__title">容器</span><span class="row__meta"><span>现在没有在跑的容器</span></span></span><span class="row__side state">—</span></div>'}
        <div class="row"><span class="row__main"><span class="row__title">磁盘</span>
          <span class="row__meta"><span>工作区 ${esc(bytes((disk.workspacesMb ?? 0) * 1024 * 1024))}</span><span>会话 ${esc(bytes((disk.piConfigMb ?? 0) * 1024 * 1024))}</span><span>数据库 ${esc(bytes((disk.dbMb ?? 0) * 1024 * 1024))}</span></span></span>
          <span class="row__side" ${diskTone}>${freeGb === null ? '读不到' : `剩 ${freeGb.toFixed(0)} GB`}</span></div>
      </div>
      ${info.warning ? `<p class="hint" style="margin-top:10px">${esc(info.warning)}</p>` : ''}

      <section class="section">
        <div class="section__head"><h2 class="section__title">清理旧工作区</h2><span class="section__note">只删工作目录，不动仓库和数据湖</span></div>
        <div class="sys-block">
          <p style="font-size:0.875rem;color:var(--ink-2)">删掉 30 天前、且已经结束的工单留下的工作目录。</p>
          ${cleanup ? `<p style="margin-top:6px;font-size:0.875rem"><b>${cleanup.dryRun ? '可回收' : '已回收'} ${bytes(cleanup.freedBytes ?? 0)}，共 ${cleanup.entries?.length ?? 0} 个目录</b>${cleanup.dryRun ? '' : `，实际删除 ${cleanup.deleted?.length ?? 0} 个`}</p>` : ''}
          <div class="bar-actions" style="margin-top:12px">
            <button class="btn" type="button" data-preview>先预览一下</button>
            <button class="btn btn--danger" type="button" data-run ${cleanup?.dryRun ? '' : 'disabled'}>确认清理</button>
          </div>
        </div>
      </section>

      ${backupCard()}
      ${orphanCard()}
    `
  }

  function syncOrphanUI() {
    const { selected, selectedBytes } = orphanSelection()
    const count = root.querySelector('[data-orphan-count]')
    if (count) count.textContent = `已选 ${selected.length} 个，共 ${bytes(selectedBytes)}`
    const clean = root.querySelector('[data-orphan-clean]')
    if (clean) clean.disabled = selected.length === 0
    const confirm = root.querySelector('[data-orphan-confirm]')
    if (confirm) confirm.disabled = selected.length === 0
    const text = root.querySelector('[data-orphan-confirm-text]')
    if (text) text.textContent = `会删除选中的 ${selected.length} 个文件，共 ${bytes(selectedBytes)}。删掉后找不回来。`
  }

  root.addEventListener('click', async (event) => {
    if (event.target.closest('[data-pause]')) {
      const paused = ctx.overview?.()?.paused === true
      await ctx.setPaused(!paused)
      invalidateOverview()
      await bus.refreshOverview()
      await render()
      return
    }
    if (event.target.closest('[data-preview]')) {
      try {
        state.cleanup = await post('api/system/cleanup', { olderThanDays: 30, dryRun: true })
        paint()
        bus.toast(`可回收 ${bytes(state.cleanup.freedBytes ?? 0)}`)
      } catch (error) {
        bus.toast(error?.message || '预览失败', { danger: true })
      }
      return
    }
    if (event.target.closest('[data-run]')) {
      const values = await bus.sheet({
        title: '确认清理？',
        text: '30 天前、已经结束的工单，其工作目录会被删除。删掉之后这些工单的文件就找不回来了。',
        confirmLabel: '清理',
        danger: true,
      })
      if (!values) return
      try {
        state.cleanup = await post('api/system/cleanup', { olderThanDays: 30, dryRun: false })
        paint()
        bus.toast(`已回收 ${bytes(state.cleanup.freedBytes ?? 0)}`)
      } catch (error) {
        bus.toast(error?.message || '清理失败', { danger: true })
      }
      return
    }
    if (event.target.closest('[data-backup-now]')) {
      if (state.backupBusy) return
      state.backupBusy = true
      const button = event.target.closest('[data-backup-now]')
      if (button) {
        button.disabled = true
        button.textContent = '正在备份…'
      }
      try {
        const result = await post('api/system/backups', {})
        bus.toast(`备份好了：${result?.item?.name ?? '已完成'}`)
        await render()
      } catch (error) {
        bus.toast(error?.message || '备份没有成功', { danger: true })
        if (button) {
          button.disabled = false
          button.textContent = '立即备份'
        }
      } finally {
        state.backupBusy = false
        const fresh = root.querySelector('[data-backup-now]')
        if (fresh) {
          fresh.disabled = false
          fresh.textContent = '立即备份'
        }
      }
      return
    }
    if (event.target.closest('[data-orphan-clean]')) {
      if (!state.orphanSelected.size) return
      state.confirmOpen = true
      paint()
      return
    }
    if (event.target.closest('[data-orphan-cancel]')) {
      state.confirmOpen = false
      paint()
      return
    }
    if (event.target.closest('[data-orphan-confirm]')) {
      if (state.busy || !state.orphanSelected.size) return
      const ids = [...state.orphanSelected]
      state.busy = true
      const button = event.target.closest('[data-orphan-confirm]')
      if (button) button.disabled = true
      try {
        const result = await post('api/system/orphans/cleanup', { ids })
        state.orphanSelected.clear()
        state.confirmOpen = false
        bus.toast(`已清理，释放了 ${bytes(result?.freedBytes ?? 0)}`)
        await render()
      } catch (error) {
        bus.toast(error?.message || '清理没有成功', { danger: true })
        if (button) button.disabled = false
      } finally {
        state.busy = false
      }
    }
  })

  root.addEventListener('change', (event) => {
    const box = event.target.closest('[data-orphan]')
    if (!box) return
    if (box.checked) state.orphanSelected.add(box.dataset.orphan)
    else state.orphanSelected.delete(box.dataset.orphan)
    box.closest('.orphan')?.classList.toggle('row--picked', box.checked)
    syncOrphanUI()
  })

  render()
  return {
    root,
    refresh: () => (state.confirmOpen || state.busy || state.backupBusy ? Promise.resolve() : render()),
    destroy() { alive = false },
  }
}
