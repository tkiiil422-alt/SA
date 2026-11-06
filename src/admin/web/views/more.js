/** 更多: the low-frequency destinations, grouped, each with one plain sentence. */
import { logout as apiLogout } from '../lib/api.js'
import { bus } from '../lib/bus.js'
import { icons } from '../lib/view.js'

const BUILD = 'r5 · 2026-11-05'

const THEMES = [
  { value: 'system', label: '跟随系统' },
  { value: 'light', label: '浅色' },
  { value: 'dark', label: '深色' },
]

const GROUPS = [
  {
    title: '资源与记录',
    rows: [
      { name: '连接', desc: '飞书、GitHub、邮箱、密钥库、网页预览的绑定状态', href: '#/connections' },
      { name: '花费', desc: '今天、7 天、30 天的花费与调用', href: '#/usage' },
      { name: '判断记录', desc: '每次受理或忽略的理由，可回看', href: '#/decisions' },
      { name: '事件', desc: '机器做过的事，最近 200 条', href: '#/events' },
    ],
  },
  {
    title: '设置与管理',
    rows: [
      { name: '设置', desc: '受理规则、执行环境、模型与预算、飞书、预览、账号', href: '#/settings/policy' },
      { name: '密钥', desc: '加密保存的密钥，决定哪些任务能拿到', href: '#/secrets' },
      { name: '系统', desc: '服务健康、槽位、磁盘、暂停接单、清理旧工作区', href: '#/system' },
    ],
  },
]

const rowHtmlMore = (row) => `<a class="more__row" href="${row.href}">
  <span class="more__text"><span class="more__name">${row.name}</span><span class="more__desc">${row.desc}</span></span>
  <span class="more__chev">${icons.chev}</span>
</a>`

export function mount(ctx) {
  const root = document.createElement('div')
  root.className = 'page'
  const paint = () => {
    const theme = bus.theme?.() ?? 'system'
    root.innerHTML = `
    <div class="head">
      <div class="head__row"><h1 class="head__title">更多</h1></div>
      <p class="head__sub">低频的东西都在这里，常用的事不放这</p>
    </div>
    <section class="section" style="margin-top:0">
      <div class="section__head"><h2 class="section__title">外观</h2><span class="section__note">只影响这台浏览器</span></div>
      <div class="seg" role="group" aria-label="主题">
        ${THEMES.map((item) => `<button class="seg__i" type="button" data-theme="${item.value}" aria-pressed="${item.value === theme}">${item.label}</button>`).join('')}
      </div>
    </section>
    ${GROUPS.map((group) => `<section class="more-group">
      <h2 class="more-group__title">${group.title}</h2>
      <div class="more">${group.rows.map(rowHtmlMore).join('')}</div>
    </section>`).join('')}
    <section class="more-group">
      <div class="more">
        <button class="more__row" type="button" data-logout>
          <span class="more__text"><span class="more__name">退出登录</span><span class="more__desc">这台设备上的会话会立即失效</span></span>
          <span class="more__chev">${icons.chev}</span>
        </button>
      </div>
    </section>
    <p class="hint-row" style="margin-top:14px">界面 ${BUILD}。样式和脚本都由服务端直出，普通刷新就会更新；看不到新东西时按 Ctrl+Shift+R 强制刷新一次。</p>`
  }

  paint()

  root.addEventListener('click', async (event) => {
    const themeButton = event.target.closest('[data-theme]')
    if (themeButton) {
      bus.setTheme(themeButton.dataset.theme)
      paint()
      return
    }
    if (!event.target.closest('[data-logout]')) return
    const values = await bus.sheet({
      title: '退出登录？',
      text: '这台设备上的会话会立刻失效，下次要用口令重新登录。',
      confirmLabel: '退出',
      danger: true,
    })
    if (!values) return
    try {
      await apiLogout()
    } catch { /* the cookie is gone either way */ }
    location.reload()
  })

  return { root, refresh: async () => paint(), destroy() {} }
}
