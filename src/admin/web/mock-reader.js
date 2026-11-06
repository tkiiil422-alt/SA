/**
 * Mock documents for the reader (F4 owns this file).
 *
 * The built-in mock answers `GET api/tickets/:id/files` before feature routes, so
 * `mock.js` dispatches feature routes first (one small insertion). This module then
 * serves a realistic file tree for T-20261105-0912 while reproducing the built-in
 * behaviour for every other ticket.
 *
 * Paths:
 *   output/项目总结.md       long, rich document (toc, nested/task lists, table, code, quote, image, link)
 *   output/design.md         relative-link target
 *   output/unsafe.md         hostile samples (must stay inert)
 *   output/data.csv          quoted CSV
 *   output/result.json       nested JSON
 *   output/page.html         HTML that must only ever be shown as source
 *   output/assets/arch.png   inline image (raw=1)
 *   output/blob.bin          binary file
 *   reports/2026-11-05.md    alias used by the existing route audit
 */

const TICKET_ID = 'T-20261105-0912'
const FENCE = '```'
const IMAGE_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAEAAAAAgCAIAAAAt/+nTAAAAX0lEQVR4nO3PMQ3AMBDF0EMSCh3Co0OHTmVQJoHQIVgL4gbrS5YMwK/G+0RX+IEA+kAAfSCAPugC5rmjE0AngE4AXT5g3dnxBwLoAwH0gQD6oAv4jis6AXQC6ATQxQN+tYj+aowwxd4AAAAASUVORK5CYII='

function longDocument() {
  return [
    '# 2026 年 Q1 销售数据项目总结',
    '',
    '这份总结把三个区域的原始表整理成了一张汇总表，并给出 **三条能直接拿去做决策的结论**。',
    '文中的数字都可以用 `output/data.csv` 复核，方法写在 [详细设计](./design.md) 里。',
    '',
    '## 目标',
    '',
    '把华东、华南、华北三份口径不一致的销售表合并，回答三个问题：',
    '',
    '1. 哪个区域增长最快',
    '2. 哪类客户贡献了大部分收入',
    '3. 下个季度最该补的短板是什么',
    '',
    '### 验收标准',
    '',
    '- [x] 三份表的字段已经对齐',
    '- [x] 缺失的两天记录用同口径补齐',
    '- [ ] 和财务的月报交叉核对一次',
    '- [ ] 把结论发给销售负责人',
    '',
    '## 数据来源',
    '',
    '| 区域 | 原始行数 | 缺失天数 | 口径 |',
    '| :--- | ---: | :---: | :--- |',
    '| 华东 | 12,480 | 2 | 含税，按订单日 |',
    '| 华南 | 8,932 | 0 | 含税，按发货日 |',
    '| 华北 | 6,410 | 0 | 不含税，按订单日 |',
    '',
    '三份表里只有华北是不含税的，汇总前统一乘了 1.06。华东缺失的两天用前后各一周的均值补齐。',
    '',
    '## 处理过程',
    '',
    '1. 先把三个文件读进内存，统一字段名',
    '2. 清洗掉测试订单和内部调拨',
    '   - 订单号以 `TEST-` 开头的丢弃',
    '   - 客户名是「内部」的丢弃',
    '3. 生成汇总表，同时输出按月和按周两种同比',
    '',
    '核心的合并函数长这样：',
    '',
    FENCE + 'ts',
    'type Row = { region: string; amount: number; day: string }',
    '',
    'export function merge(rows: Row[]): Map<string, number> {',
    '  const total = new Map<string, number>()',
    '  for (const row of rows) {',
    '    const key = `${row.region}:${row.day.slice(0, 7)}`',
    '    total.set(key, (total.get(key) ?? 0) + row.amount)',
    '  }',
    '  return total',
    '}',
    FENCE,
    '',
    '> 结论要能追溯到行，所以每个合计都保留了 `region` 和月份。',
    '> 没有来源的数字一律不写进报告。',
    '',
    '## 结论',
    '',
    '### 一、华东增长最快，但基数也最大',
    '',
    '华东 Q1 同比 +34%，华南 +19%，华北 +8%。华东的增量里有一半来自两个新客户，续约率并没有明显变化。',
    '',
    '### 二、大客户贡献了六成收入',
    '',
    '收入前 10 的客户占了 61%。其中 3 个客户的合同在 Q2 到期，需要提前一个月联系。',
    '',
    '### 三、华北的短板是客单价',
    '',
    '华北订单数不少，但客单价只有华东的 62%。先别急着扩量，把套餐结构调顺更划算。',
    '',
    '## 架构与文件',
    '',
    '工作区里的产出这样摆：',
    '',
    '- `output/项目总结.md` 这份文档',
    '- `output/data.csv` 清洗后的明细（前 500 行）',
    '- `output/result.json` 汇总结果，给下游脚本用',
    '',
    `![三个区域的处理流程](./assets/arch.png)`,
    '',
    '更细的字段说明和复现步骤见 [详细设计](./design.md)。',
    '',
    '## 风险与后续',
    '',
    '- 财务月报还没核对，数字可能有 1–2% 的差异',
    '- 华北的税率假设要在下季度确认一次',
    '- 两条缺失记录是均值补的，敏感分析里要标注',
    '',
    '---',
    '',
    '## 附录',
    '',
    '### 复现命令',
    '',
    FENCE + 'bash',
    'node output/merge.mjs --input data/raw --out output/data.csv',
    'node output/summarize.mjs --input output/data.csv',
    FENCE,
    '',
    '### 术语',
    '',
    '| 词 | 意思 |',
    '| --- | --- |',
    '| 同比 | 和去年同一时间段比 |',
    '| 客单价 | 每个客户的平均成交金额 |',
    '| 续约率 | 到期后继续签约的客户比例 |',
    '',
    '==这份文档由 AI 生成，关键数字请对照原始表。==',
  ].join('\n')
}

function designDocument() {
  return [
    '# 详细设计',
    '',
    '## 字段',
    '',
    '| 字段 | 类型 | 说明 |',
    '| --- | --- | --- |',
    '| `region` | string | 华东 / 华南 / 华北 |',
    '| `amount` | number | 含税金额，单位元 |',
    '| `day` | string | `YYYY-MM-DD` |',
    '',
    '## 复现',
    '',
    '1. 把三份原始表放进 `data/raw/`',
    '2. 运行 `node output/merge.mjs --input data/raw`',
    '3. 打开 [项目总结](./项目总结.md) 检查结论',
  ].join('\n')
}

function unsafeDocument() {
  return [
    '# 恶意样例',
    '',
    '下面这些都是应该被当成普通文字的东西，页面里不能执行。',
    '',
    '<script>window.__xss = (window.__xss || 0) + 1</script>',
    '',
    '<img src=x onerror="window.__xss = (window.__xss || 0) + 1">',
    '',
    '[点我](javascript:window.__xss=1)',
    '',
    '![图片](javascript:window.__xss=1)',
    '',
    '[大小写混写](JaVaScRiPt:window.__xss=1)',
    '',
    '[实体编码](java&#115;cript:window.__xss=1)',
    '',
    '[冒号实体](javascript&colon;window.__xss=1)',
    '',
    '[数据链接](data:text/html,<script>window.__xss=1</script>)',
    '',
    '正常链接：[示例站点](https://example.com/safe)',
  ].join('\n')
}

function csvDocument() {
  const rows = ['姓名,城市,金额,备注', '"张,三",上海,299.00,"含税, 已付"', '李四,北京,1280.50,"分两行\n第二行"', '王五,广州,88.00,新客户']
  for (let index = 1; index <= 12; index += 1) {
    rows.push(`客户${index},城市${index},${(index * 137.5).toFixed(2)},第 ${index} 行`)
  }
  return rows.join('\n')
}

function jsonDocument() {
  return JSON.stringify({
    generatedAt: '2026-11-05T15:20:00.000Z',
    regions: [
      { name: '华东', rows: 12480, growth: 0.34, missingDays: ['2026-01-08', '2026-01-09'] },
      { name: '华南', rows: 8932, growth: 0.19, missingDays: [] },
      { name: '华北', rows: 6410, growth: 0.08, missingDays: [] },
    ],
    notes: ['华北不含税，已乘 1.06', '测试订单已剔除'],
  }, null, 2)
}

function htmlDocument() {
  return [
    '<!doctype html>',
    '<html lang="zh-CN">',
    '<head><meta charset="utf-8"><title>演示页面</title></head>',
    '<body>',
    '  <div id="evil-root" class="from-html">如果这段被渲染，页面里会出现这个元素。</div>',
    '  <script>window.__xss = (window.__xss || 0) + 1</script>',
    '</body>',
    '</html>',
  ].join('\n')
}

function base64Bytes(value) {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes
}

function byteLength(value) {
  return new TextEncoder().encode(String(value)).length
}

function findDir(files, dir) {
  const prefix = dir ? `${dir}/` : ''
  const map = new Map()
  for (const file of files) {
    if (!file.path.startsWith(prefix)) continue
    const rest = file.path.slice(prefix.length)
    if (!rest) continue
    const [head, ...tail] = rest.split('/')
    if (tail.length) {
      if (!map.has(head) || map.get(head).type !== 'dir') map.set(head, { name: head, type: 'dir' })
    } else if (!map.has(head)) {
      map.set(head, { name: head, type: 'file', size: file.size })
    }
  }
  return [...map.values()].sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name, 'zh-CN') : a.type === 'dir' ? -1 : 1))
}

function responseText(text, downloadName) {
  const headers = {
    'content-type': downloadName ? 'application/octet-stream' : 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  }
  if (downloadName) headers['content-disposition'] = `attachment; filename*=UTF-8''${encodeURIComponent(downloadName)}`
  return new Response(text, { status: 200, headers })
}

export function install(registry) {
  const state = registry.state
  const ticket = state?.tickets?.find((item) => item.id === TICKET_ID)
  if (!ticket) return

  const modifiedAt = new Date(Date.now() - 23 * 60000).toISOString()
  const docs = new Map()
  const add = (path, body, options = {}) => {
    docs.set(path, {
      path,
      body,
      text: options.text !== false,
      image: Boolean(options.image),
      binary: Boolean(options.binary),
      modifiedAt,
      size: options.image ? base64Bytes(IMAGE_BASE64).length : byteLength(body),
    })
  }

  add('output/项目总结.md', longDocument())
  add('output/design.md', designDocument())
  add('output/unsafe.md', unsafeDocument())
  add('output/data.csv', csvDocument())
  add('output/result.json', jsonDocument())
  add('output/page.html', htmlDocument())
  add('output/assets/arch.png', IMAGE_BASE64, { text: false, image: true })
  add('output/blob.bin', 'BINARY', { text: false, binary: true })
  add('reports/2026-11-05.md', longDocument())

  const combined = () => [
    ...(Array.isArray(ticket.files) ? ticket.files : []),
    ...[...docs.values()].map((doc) => ({ path: doc.path, size: doc.size })),
  ]

  registry.add('GET', '/api/tickets/:id/files', ({ params, url }) => {
    const id = decodeURIComponent(String(params.id ?? ''))
    const target = state.tickets.find((item) => item.id === id)
    if (!target) return registry.fail(404, 'unknown_ticket', '找不到这张任务票。')
    const rawPath = url.searchParams.get('path') ?? ''
    if (rawPath.split('/').some((part) => part === '..')) return registry.fail(400, 'bad_path', '路径不合法。')
    const normalized = rawPath.replace(/^\/+|\/+$/g, '')
    const download = url.searchParams.get('download') === '1'
    const raw = url.searchParams.get('raw') === '1'
    if (!target.workspace?.exists && id !== TICKET_ID) {
      return { path: normalized, exists: false, type: 'dir', entries: [] }
    }

    const doc = id === TICKET_ID ? docs.get(normalized) : undefined
    if (doc) {
      if (doc.image) {
        const bytes = base64Bytes(IMAGE_BASE64)
        if (raw || download) {
          const headers = {
            'content-type': 'image/png',
            'content-length': String(bytes.byteLength),
            'cache-control': 'no-store',
            'x-content-type-options': 'nosniff',
          }
          if (download) headers['content-disposition'] = `attachment; filename*=UTF-8''${encodeURIComponent('arch.png')}`
          return new Response(bytes, { status: 200, headers })
        }
        return {
          path: normalized,
          exists: true,
          type: 'file',
          name: normalized.split('/').at(-1),
          size: doc.size,
          modifiedAt: doc.modifiedAt,
          binary: true,
        }
      }
      if (download) {
        const body = doc.text ? doc.body : IMAGE_BASE64
        return responseText(body, normalized.split('/').at(-1))
      }
      if (doc.binary) {
        return {
          path: normalized,
          exists: true,
          type: 'file',
          name: normalized.split('/').at(-1),
          size: doc.size,
          modifiedAt: doc.modifiedAt,
          binary: true,
        }
      }
      return {
        path: normalized,
        exists: true,
        type: 'file',
        name: normalized.split('/').at(-1),
        size: doc.size,
        modifiedAt: doc.modifiedAt,
        text: doc.body,
        truncated: false,
      }
    }

    // Built-in-like behaviour for every other ticket and for files the world already had.
    const files = id === TICKET_ID ? combined() : (Array.isArray(target.files) ? target.files : [])
    const file = files.find((item) => item.path === normalized)
    if (file) {
      return {
        path: normalized,
        exists: true,
        type: 'file',
        name: normalized.split('/').at(-1),
        size: file.size,
        modifiedAt: target.updatedAt ?? modifiedAt,
        binary: file.binary,
        text: file.binary ? undefined : file.text,
        truncated: false,
      }
    }
    const exists = normalized === '' || files.some((item) => item.path.startsWith(`${normalized}/`))
    if (!exists) return { path: normalized, exists: false, type: 'dir', entries: [] }
    return {
      path: normalized,
      exists: true,
      type: 'dir',
      entries: findDir(files, normalized).map((entry) => ({ ...entry, modifiedAt: target.updatedAt ?? modifiedAt })),
    }
  })
}
