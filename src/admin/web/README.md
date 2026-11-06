# 后台前端（v3 地基）

纯静态单页：无框架、无构建。`index.html` + `app.js` + `style.css`，视图在 `views/`，
壳层服务在 `lib/`。三秒轮询由壳层统一包成 `snapshot → refresh → restore`，视图不用自己记状态。

## 令牌

v3 把 v2 的 `--paper`（页面底）改名为 `--desk`，`--paper` 现在是内容面 / 阅读面。
`--surface`、`--surface-2` 保留为别名（分别指向 `--paper`、`--paper-2`），旧组件不需要改。

| 令牌 | 亮色 | 暗色 | 用途 |
| --- | --- | --- | --- |
| `--desk` | `#e8ebeb` | `#0b100e` | 页面底（桌面） |
| `--paper` | `#fbfcfb` | `#141b18` | 内容面、卡片、阅读区 |
| `--paper-2` | `#f3f5f4` | `#1a2420` | 次级块、引用、代码底 |
| `--surface` | `var(--paper)` | 同左 | v2 兼容别名 |
| `--surface-2` | `var(--paper-2)` | 同左 | v2 兼容别名 |
| `--seat-analyst` | `#8a5600` | `#e2a93f` | 需求分析师 · 琥珀 37° |
| `--seat-architect` | `#334e9e` | `#9db0f2` | 架构师 · 靛蓝 225° |
| `--seat-engineer` | `#0b6b7b` | `#69c8e0` | 实现工程师 · 青 189° |
| `--seat-tester` | `#8030a8` | `#d8a0f5` | 测试与验收 · 紫 280° |
| `--seat-risk` | `#9a2f52` | `#ef8cb6` | 风险与安全 · 酒红 340° |
| `--seat-host` | `var(--ink)` | `var(--ink)` | 主持人 |
| `--font-read` | — | — | 阅读体（宋体 / 思源宋体） |
| `--r6` / `--r12` / `--r-full` | `6px` / `12px` / `999px` | 同左 | 圆角三档；`--r`/`--r-sm` 分别指向 12/6 |

席位色相刻意避开 `--human`（朱砂，8°）与 `--machine`（松绿，168°）。

### 对比度实测

用 `python -I design/panel-v3/tools/contrast.py` 实测（同一脚本可复跑）：

| 组合 | 亮色 | 暗色 | 要求 |
| --- | --- | --- | --- |
| 正文 `--ink` / `--paper` | 17.19:1 | 15.01:1 | ≥ 4.5 |
| 次要 `--ink-2` / `--paper` | 8.1:1 | 9.08:1 | ≥ 4.5 |
| 说明 `--ink-3` / `--paper` | 5.28:1 | 5.5:1 | ≥ 4.5 |
| `--human` / `--paper` | 5.79:1 | 6.0:1 | ≥ 4.5 |
| `--machine` / `--paper` | 6.16:1 | 8.32:1 | ≥ 4.5 |
| `--info` / `--paper` | 7.02:1 | 8.25:1 | ≥ 4.5 |

席位色（文字 / `--paper`，方章字形 / 14%（亮）或 20%（暗）底色）：

| 席位 | 亮色文字 | 亮色方章 | 暗色文字 | 暗色方章 |
| --- | --- | --- | --- | --- |
| 需求分析师 | 5.98:1 | 4.9:1 | 8.32:1 | 5.65:1 |
| 架构师 | 7.5:1 | 6.05:1 | 8.27:1 | 5.55:1 |
| 实现工程师 | 6.0:1 | 4.9:1 | 9.12:1 | 5.94:1 |
| 测试与验收 | 7.03:1 | 5.61:1 | 8.56:1 | 5.71:1 |
| 风险与安全 | 7.04:1 | 5.6:1 | 7.58:1 | 5.25:1 |
| 主持人 | 17.19:1 | 12.86:1 | 15.01:1 | 8.41:1 |

全部满足：席位文字对 `--paper` ≥ 4.5:1，方章字形对其底色 ≥ 3:1。

## 阅读体

```html
<article class="read">…</article>
```

`.read` 使用 `--font-read`，1.0625rem / 1.85，行宽 ≤ 38em；标题回落到界面无衬线加粗，
左侧 3px 墨色竖线。界面其余部分继续用系统无衬线。

## 壳层状态保持

视图里凡是会被三秒轮询重建的折叠块，都必须带稳定的键：

```html
<details data-keep="ticket.older-reports">…</details>
```

`lib/keep.js` 在每次 refresh 前后保存/恢复 `details` 的 open、`window.scrollY`、
内部滚动容器的 `scrollTop`、以及焦点元素的 `data-focus-key`（或 `id`）和输入框选区。
用户手动展开/滚动会即时写入 live 记录；如果动作发生在异步刷新期间，恢复时以更新的动作为准。

## 回归工具（设计稿仓库中的 `design/panel-v3/tools/`，未随代码发布）

```bash
# 零依赖静态服务器（127.0.0.1，正确 MIME）
node design/panel-v3/tools/serve.mjs src/admin/web 8793

# 展开缩回回归：设置→飞书指引、密钥→已处理、任务详情→更早的报告
MSYS_NO_PATHCONV=1 node design/panel-v3/tools/keep-open.mjs --url "http://127.0.0.1:8793/index.html?mock=1"

# 20 条路由 × 320/390/768/1120/1440：控制台错误、横向溢出、<44px 目标
MSYS_NO_PATHCONV=1 node design/panel-v3/tools/audit-all.mjs

# 壳层与草稿冒烟：底栏顺序、左栏分组、面板开关、刷新后草稿
MSYS_NO_PATHCONV=1 node design/panel-v3/tools/f1-smoke.mjs
```

Chrome 的临时用户目录统一放在系统临时目录，不进 `web/`。

## 上传与项目

`lib/upload.js` 是模块级单例：面板关掉、路由切走都不中断上传。壳层只通过 `bus.upload.state()` / `bus.upload.subscribe(fn)` 画顶栏上传胶囊；视图直接 import 模块函数：

```js
import * as upload from '../lib/upload.js'
upload.configure({ fetch, base, chunkSize, retryDelays, pollInterval, sleep, now }) // 测试注入
await upload.start(file, { projectName })  // 到 done / failed / paused 时 resolve
upload.pause() / await upload.resume() / await upload.cancel()
upload.state() / upload.subscribe(fn) / upload.onReady(fn) / upload.pending() / upload.forgetPending() / upload.dismiss()
```

### 状态机

```
idle → uploading → finishing → extracting → done
         ↕ paused                 ↘ failed
任何上传阶段 ── cancel ──> idle
```

- `uploading`：进度 0–90%（已提交字节 / 总大小）。
- `finishing`：上传完、等 `finish` 返回项目编号，90%。
- `extracting`：90–100%，按 `GET api/projects/:id` 的 `progress.done/total`；`total` 还是 0 时停在 90%。
- `done`：100%，`done=true`；`onReady` 只在这一次触发（失败不触发）。
- `failed`：`error` 是给人看的一句话；网络失败会保留可续传记录，项目解压失败会清掉。
- `paused`：401 或手动暂停；`notice` 说明原因，登录后可 `resume()`。

`state()` 返回 `{ active, phase, name, size, sent, percent, speedBps, etaSec, extractDone, extractTotal, projectId, uploadId, error, notice, done }`。速度是最近约 5 秒的滑动平均。

### 分块、校验与重试

- 分块大小 = `min(服务端 chunkSize, 4 MiB)`；`configure({ chunkSize })` 可覆盖（测试用 1 MiB）。
- 每块 `PUT api/uploads/:id?offset=N`，`Content-Type: application/octet-stream`，`X-SA-Request: 1`，`credentials: same-origin`。
- 分块 SHA-256 通过 `crypto.subtle.digest` 计算；**`crypto.subtle` 只在安全上下文存在**。线上是 `http://175.178.18.140:18081/sa/`（普通 HTTP），此时探测到没有 subtle 就不发 `x-chunk-sha256`，也不报错、不手写哈希。服务端把它当可选项，并始终核对 content-length。
- 网络错误 / 5xx：指数退避重试 5 次（1、2、4、8、16 秒）。`409` 用响应里的 `received` 对齐后继续；其它 4xx 直接失败并显示服务端 `message`；`401` 暂停并保留进度；`404` 清掉本地记录并说明已过期。

### 持久化与续传

`localStorage['sa-upload']` 记录 `{ uploadId, projectId?, name, size, lastModified, phase }`。刷新后项目页先用 `pending()` 显示续传条，再 `GET api/uploads/:id` 取 `received` 算百分比。用户选择文件后 `start()` 核对文件名、大小（有 `lastModified` 时一并核对）：不一致就拒绝并说明；服务端返回 404 就清记录并提示重新上传。取消会 `DELETE api/uploads/:id` 并清记录。

`beforeunload` 只在上传/解压活跃时挂上；`navigator.wakeLock('screen')` 失败或不存在时静默忽略，结束或暂停时释放。

### Mock 参数

`?mock=1` 下 `mock-projects.js` 提供上传、项目、文件浏览与 `settings/projects`：

| 参数 | 作用 |
| --- | --- |
| `mockUpload=slow` | 每块约 380 ms，便于看进度、暂停、截图 |
| `mockUpload=fast` | 每块约 15 ms |
| `mockUpload=fail409` | 第二块先落盘再返回 409，验证客户端对齐 |
| `mockUpload=failnet` | 所有分块返回 503，验证重试耗尽后的提示 |
| `mockProjects=empty` | 不生成示例项目（空态截图） |
| `mockMaxMb=1` | 把上传上限临时改成 1 MB，验证选文件时的拒绝 |

`GET api/settings/council` 与 `POST api/councils` 由 F3 的 `mock-council.js` 提供（`mock.js` 让后安装的路由优先）；`mock-projects.js` 不再保留占位路由。Mock 的上传和项目存在 `sessionStorage`，刷新页面仍能演示续传；上传分块是 raw `octet-stream`，`mock.js` 的写请求检查只对这一种放行。

## 阅读器与连接页

### 路由

| 路由 | 内容 |
| --- | --- |
| `#/doc/ticket/<ticketId>?path=<相对路径>` | 任务工作区里的文档；`GET api/tickets/<id>/files?path=…` |
| `#/doc/project/<projectId>?path=<相对路径>` | 项目文件树；`GET api/projects/<id>/files?path=…` |
| `#/doc/council/<councilId>` | 会商任务书；读 `GET api/councils/<id>` 的 `brief`，没有就显示「读不到这份文档」 |
| `#/connections` | 飞书 / GitHub / 邮箱 / 密钥库 / 网页预览的连接状态 |

文件接口与 `src/admin/api.ts` 的 `handleFiles` 同形：目录返回 `entries`；文件返回
`text` / `truncated` / `binary`；图片用 `…&raw=1`；下载用 `…&download=1`（≤ 200 MB，流式回写）。
阅读器按扩展名处理：`.md` 走 `renderDoc`，`.csv` 前 500 行成表（首行表头，支持引号、逗号、换行），
`.json` 解析后缩进，`.html` **只显示源码**，`.txt` 与代码类等宽，图片直接显示，二进制给下载链接。
`truncated` 为真时顶部提示「文件太大，只显示了开头一部分」并给下载链接。

3 秒轮询时 `refresh()` 故意不重绘；阅读位置、目录高亮和窄屏目录的展开状态不会被打断。
目录按钮用 `scrollIntoView`，不写 `location.hash`，避免和壳层路由冲突。`Esc` 先 `history.back()`，
没有上一页时回任务 / 项目页。打印样式会隐藏导航、顶栏、工具条和目录，正文 11pt，链接后追加 URL，
`pre` 自动换行。

### `lib/markdown.js`

`renderMarkdown(text)` 保持原有签名与输出，现有调用方（任务详情的报告等）不需要改。
新增：

```js
import { renderDoc } from './lib/markdown.js'

const { html, toc } = renderDoc(text, {
  resolveImage: (src) => 'api/tickets/T/files?path=…&raw=1' | null,
  resolveLink: (href) => '#/doc/ticket/T?path=…' | null,
  headingIds: true, // false 时不给标题 id，也不产生目录
})

// toc: [{ level: 2 | 3, id: '目标', text: '目标' }, …]
```

标题 id 由标题文字生成：小写、空白转 `-`、去掉标点、保留中文 / 字母 / 数字；空标题用
`section`，重复时追加 `-2`、`-3`。同一份文档的 id 稳定可复现。支持标题、粗体 / 斜体 / 删除线、
行内码、围栏代码（`lang-xxx` + 右上「复制」）、有序 / 无序 / 嵌套列表、任务列表（禁用的
`<input type=checkbox disabled aria-label=…>`）、可嵌套引用、`---`、带对齐的管道表格
（外层 `.table-wrap` 横向滚动）、http(s) 链接、图片与相对链接改写。
`==文字==` 渲染为 `<mark>`（只在 `renderDoc` 路径生效，`renderMarkdown` 不处理；行内码与代码块内不处理）。
`mark` 样式：中性底色 `--line` 加底部荧光线 `--line-2`，不用 `--human` / `--machine` / 席位色；打印时保留颜色。

### 安全规则

- 先转义再套格式，**从不透传原始 HTML**。
- 只有 `http(s)` 外链会生成 `<a target="_blank" rel="noopener noreferrer">`；相对链接交给
  `resolveLink`，返回 `null` 时只显示文字。
- 图片：`http(s)` 外链不加载，只显示 alt 文字与可点链接；相对路径交给 `resolveImage`，
  且只放行 `png / jpg / jpeg / gif / webp / avif`。
- `javascript:`、`data:`、`vbscript:`、`file:` 一律不生成链接或图片，即使大小写混写、
  夹空白 / 控制字符、或写成 HTML 实体（`&#115;`、`&colon;`）。
- 写进 `href` / `src` / `alt` / `id` / `class` 的值都经过转义；代码块语言只接受
  `[A-Za-z0-9_+-]`。含引号或事件处理器样式的 http URL 直接降级为文字。
- 恶意文本里的 `javascript:` / `onerror=` 会以 HTML 实体（`&#58;` / `&#61;`）输出，
  屏幕上看起来一样，但扫描 HTML 字符串看不到可执行片段。

### 复制降级链

线上后台走普通 HTTP，`navigator.clipboard` 可能不存在：

1. `navigator.clipboard.writeText`（存在且成功时）；
2. 隐藏 `<textarea>` + `document.execCommand('copy')`；
3. 都不行时打开只读文本框（已全选），让人手动复制。

成功时按钮短暂显示「已复制」，并通过 `aria-live` 播报。代码块右上角的「复制」走同一条链。

### 连接页状态判定

每个接口独立 `catch`：一个失败只让那一行显示「读不到状态」，其它行照常。3 秒轮询只更新
文字与链接，不重绘骨架，因此不会闪。

| 行 | 判定 |
| --- | --- |
| 飞书 | `status.state=error` → 出错：原因；没有 `appId` / `appSecretSet` → 未配置；已配置但 `enabled=false` → 已配置但没开；`connected` → 已连接；`connecting` → 正在连接 |
| GitHub | `tokenSet=false` → 未配置；`tokenSet && enabled` → 已连接；`tokenSet && !enabled` → 已配置但没开 |
| 邮箱 | `status.state=error` → 出错：原因；没有 `address` 或 `passwordSet=false` → 未配置；已配置但 `enabled=false` → 已配置但没开；`connected` → 已连接；其它 → 正在连接 |
| 密钥库 | 有密钥 → 已配置（N 个）；没有 → 未配置 |
| 网页预览 | `enabled=true` → 已开启；否则 → 已配置但没开 |

「去绑定」链接带 `?focus=unset`（`#/settings/feishu|github|email|preview`），落地后由设置页
滚动并聚焦第一个未填字段；密钥库固定链到 `#/secrets`。GitHub 与邮箱都没绑定时，页面底部
给出一句建议顺序。

## 会商与任务书

### 路由与 mock

- `#/council/<id>`：会商室。运行中每 1.5 秒自己拉一次；`done / failed / cancelled` 后停止自轮询，交给壳层的 3 秒刷新。
- `#/tickets/<id>`：任务详情。顶部依次是问题卡、任务书、产出文档、项目与导出；决策会商在「进展」里展开。
- mock 参数加在页面 URL 上：`?mock=1&mockCouncil=fast|slow|fail|partial`。
  `fast` 约 3 秒走完；`slow` 约 20 秒，能看着发言一条条出现；`fail` 五位都失败；`partial` 风险与安全缺席、其余照常汇总。
- mock 会商：`c_brief_run`（运行中）、`c_brief_done`（完成，关联 `T-20261105-0950`）、`c_brief_fail`（失败）、
  `c_decision_done`（决策模式）。带任务书、产出文档和项目的票是 `T-20261105-0950`；`T-20261105-0912` 用于预览/复制回归。

### `lib/brief.js`

无 DOM 依赖，node 可直接加载；`tests/web-brief.spec.ts` 用动态 `import(pathToFileURL(...))` 测。

```js
parseBrief(markdown)
// -> { title, sections: [{ heading, body }], questions: [{ text, default }] }
appendConfirmations(markdown, answers)
// answers: [{ text, answer }] 或 { '问题': '答案' }；替换旧的「## 已确认」后追加在末尾
splitDecision(markdown)
// -> { advice, reason, alternatives, risks }；取不到的段是空串
```

### `lib/council-view.js`

会商室和任务详情共用同一套发言渲染，避免两处长得不一样：

```js
import { roundsHtml, hostNoteHtml, decisionHtml, turnHtml, copyText } from '../lib/council-view.js'

roundsHtml(council.rounds)      // 按轮分段 + 席位方章 + 阅读体正文 + 用时
hostNoteHtml(council)           // 「主持人汇总」：brief 模式一句话，decision 模式四段输出
decisionHtml(brief)             // 建议 / 理由 / 备选 / 风险
turnHtml(turn)                  // 单条发言（pending / running / done / failed）
await copyText(text, '已复制')   // clipboard -> execCommand -> 手动复制框，普通 HTTP 下也能用
```

所有会被壳层重绘的 `<details>` 都带 `data-keep`：`council.topic`、`council.brief`、`council.more`，
任务详情的 `ticket.brief`、`ticket.deliverables`、`ticket.project`、`ticket.reports`、`ticket.secrets`、`ticket.previews`、
`ticket.links`、`ticket.progress`、`ticket.usage`、`ticket.files`、`ticket.older-reports`、`ticket.more-info`，
以及决策会商的 `ticket.council-live`、`ticket.council-turns-<status>`。

## 其余页面的版式（F5a）

样式在 `css/pages.css`（页面专用）与 `style.css`（通用）。原则：列表用分隔线，不套卡片；只有「等你拍板」的问题卡用卡片（左侧 3px 朱砂竖线）。

| 类名 | 用途 |
| --- | --- |
| `.list` + `.row.row--link` | 分组列表行；`j/k` 依赖 `.row--link` 保留 |
| `.row--compact` | 「机器在干活」的单行紧凑行（只一行标题，状态词在前） |
| `.row__meta` | 元信息，段与段之间用 `border-left: 1px solid var(--line)` 分隔，不用 `·` |
| `.strip` > `.num` | 数字行：一条上下分隔线，段间竖线；桌面 ≥ 1120 隐藏（概况栏承担） |
| `.strip-note` | 数字行下面的说明 |
| `.ask` | 「需要你处理」问题卡：朱砂左竖线，`.ask__kind` 写状态词 |
| `.connect-hint` | 今日页引导条（墨色竖线，可关闭，`localStorage['sa-connect-hint-closed']`） |
| `.sys-block` | 系统页的块：分隔线，不套卡片 |
| `.filterchip` | 「只看某某」的筛选提示，文案用逗号，不用 `·` |

圆角三档：`--r6`（输入、标签）、`--r12`（面板、弹层）、`--r-full`（胶囊）。
`#aside` 顶部留 76px，给 `.compose-fab` 让位；1120–1439 的 `.head` 右侧留 9.5rem，避开发任务按钮。

## 任务页双栏（F5b）

- 断点：`window.matchMedia('(min-width: 1200px)')`，由 `app.js` 的 `splitMode()` 读取。
- ≥ 1200：`#/tickets` 与 `#/tickets/:id` 都挂载 `views/tickets.js`，`ctx.split = true`，`ctx.params.id` 可为空。列表在左（`.split__list`，380px，`data-keep-scroll="tickets.list"`），详情在右（`.split__detail`）。
- 在双栏内切换 id 不卸载列表：`app.js` 调用视图实例的 `select(id)`，列表的滚动、搜索、筛选、批量选择保留。窄→宽、宽→窄由 `matchMedia` 的 `change` 事件调用 `renderRoute()` 重新挂载。
- `< 1200`：行为与之前一致，列表页和详情页是两个整页。
- `ticket.js` 只在 `ctx.split` 时给根节点加 `is-split` 类、隐藏「返回」链接。
- 样式钩子（`css/split.css`，仅 ≥ 1200 生效）：`.page.split`、`.split__list`、`.split__detail`、`.row--selected`（墨色竖线 + `--paper-2`）、`.split__detail .stickybar`（改为右栏内 sticky）、`.split__detail .detail`（单列，侧栏卡片堆在下面）。
- 检查脚本：`design/panel-v3/tools/f5b-checks.mjs`（`--shots` 输出截图）。

F5c（双栏里打开的任务不在当前筛选时）：

- 挂载时如果路由带了任务 id（`#/tickets/:id`），初始筛选为「全部」；`#/tickets` 仍为「需要你」。用户手动点过筛选后以用户为准，`select(id)` 切换选中任务不重置筛选。窄屏（非 split）不受影响。
- 选中任务不在当前筛选返回的列表里，且列表已全部加载完时，列表顶部显示 `[data-open-hint]`：「当前打开的任务不在这个筛选里」和「显示全部」按钮（切到「全部」）。提示由 `syncHint()` 增删，不重绘列表，滚动位置保留。选中任务在列表里时不显示。
- split 下列表为空的文案是「这个筛选下没有任务」，保留「看全部」入口；窄屏空态文案不变。
- 检查脚本：`design/panel-v3/tools/f5c-checks.mjs`（`--shots` 输出截图）。

## 设置页（F5a-2）

**分区条。** `views/settings.js` 里的 `<nav class="snav">` 列出 11 个分区：受理规则、执行环境、模型、费用上限、飞书、GitHub、邮箱、预览、项目、会商、账号。手机两列，720px 起三列，1120px 起四列；每项不小于 44px；当前项带 `aria-current="page"`；不横向滚动。样式在 `css/settings.css`。

**落点 `?focus=unset`。** `FOCUS_ORDER` 按分区列出关键字段，顺序即优先级：

- `feishu`：`appId`；`appSecret`（密钥，已设置标志 `appSecretSet`）；`verificationToken`（已设置标志 `verificationTokenSet`）。
- `github`：Token（`data-secret`，已设置标志 `tokenSet`）；仓库白名单第 0 个（`repos.0`）。
- `email`：`address`；应用专用密码（`data-secret`，已设置标志 `passwordSet`）；允许的发件人第 0 个（`allowedSenders.0`）。
- `preview`：`publicBase`。

其它分区不设 `FOCUS_ORDER`，只滚动到页面顶部。

落点规则：

- 只在首次加载完成后执行一次。
- 用户已经聚焦了某个输入框，或者有未保存的草稿，就不抢焦点。
- "未填"的判定：普通输入框 `trim()` 为空；密钥输入框看对应的已设置标志，未设置才算空。
- 找到第一个未填字段后：滚动到视口中央、聚焦，并给所在行加 `is-landed` 类 2 秒（2px 墨色外框，无动画）。
- 全部已填时只弹一个 toast「这一项已经设置好了」。

**`load()` 与未保存草稿。** 请求返回时如果 `state.dirty` 非空，整次回包被丢弃，不覆盖草稿，也不清空 dirty。代价：此时视图显示的是旧数据，直到保存或还原。这条规则覆盖所有分区。

**`paint()` 保焦点。** 重绘前按 `data-focus-key` 记下焦点与光标，重绘后恢复。以后设置页里新增输入框必须带 `data-focus-key="settings.<字段路径>"`，否则 3 秒轮询重绘时焦点会丢失。

**项目分区。** `GET/PUT api/settings/projects`，三个整数字段：

- `maxUploadMb`：1–65536 MB。
- `maxExtractMb`：1–1048576 MB。
- `maxFiles`：1–5000000 个。

校验在 `lib/settings-validate.js` 的 `validateProjects`，镜像 `ProjectsSchema`。解压上限小于上传上限只显示提示，不阻止保存。GET 失败时显示「读不到当前设置」和重试按钮，保存禁用，不回落默认值。

**会商分区。** `GET/PUT api/settings/council`。字段：

- `enabled`、`defaultOn`。
- `rounds`：1–3 轮。
- `maxCharsPerTurn`：100–2000。
- `moderator`：`null`（跟随默认工作模型）或 `{provider, model}`。
- `roles`：1–20 个。每个角色的 id 匹配 `^[a-z0-9][a-z0-9-]{0,31}$` 且不重复，名称 1–60 字，人设 1–2000 字；至少要有一个启用角色。

校验在 `validateCouncil`。PUT 体是严格的：只含上述顶层键；角色只含 `id, name, persona, enabled`，只有选了模型才带 `model` 键，不发 `null` 或空串。删除角色走确认层，只剩一个角色或没有任何启用角色时阻止。
