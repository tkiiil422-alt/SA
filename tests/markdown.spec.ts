/**
 * The web admin is plain JavaScript served as-is. These tests load it through a
 * dynamic import so `tsc --noEmit` never has to type-check the browser module.
 */
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'

interface TocEntry {
  level: number
  id: string
  text: string
}

interface DocOptions {
  resolveImage?: (src: string) => string | null
  resolveLink?: (href: string) => string | null
  headingIds?: boolean
}

interface MarkdownModule {
  renderMarkdown(text: string): string
  renderDoc(text: string, options?: DocOptions): { html: string; toc: TocEntry[] }
}

let md: MarkdownModule
const fence = '```'

beforeAll(async () => {
  const file = join(process.cwd(), 'src/admin/web/lib/markdown.js')
  md = (await import(pathToFileURL(file).href)) as MarkdownModule
})

describe('renderMarkdown (legacy output)', () => {
  const cases: Array<[string, string]> = [
    ['heading', '# 总览\n\n这是 **粗体** 和 *斜体*。'],
    ['lists', '## 步骤\n\n- 读数据\n- 写报告\n\n1. 第一\n2. 第二'],
    ['fence', fence + '\nconst x = 1 < 2\n' + fence],
    ['table', '| 名称 | 数量 |\n| --- | --- |\n| 苹果 | 3 |\n| 梨 | 5 |'],
    ['quote', '> 先说结论\n\n正文一句 [链接](https://example.com/a)。'],
    ['inline', '用 `npm run build` 编译，**别** 直接 *删* 文件。'],
    ['raw html', '<script>alert(1)</script> & "q"'],
    ['unclosed fence', fence + 'js\nlet a = 1\n\n# 不是标题'],
  ]

  const snapshots: Record<string, string> = {
    heading: '<div class="md"><h2 class="md__h">总览</h2>\n<p>这是 <strong>粗体</strong> 和 <em>斜体</em>。</p></div>',
    lists: '<div class="md"><h3 class="md__h">步骤</h3>\n<ul class="md__list">\n<li>读数据</li>\n<li>写报告</li>\n</ul>\n<ol class="md__list">\n<li>第一</li>\n<li>第二</li>\n</ol></div>',
    fence: '<div class="md"><pre class="code-box"><code>const x = 1 &lt; 2</code></pre></div>',
    table: '<div class="md"><table><thead><tr><th>名称</th><th>数量</th></tr></thead><tbody><tr><td>苹果</td><td>3</td></tr><tr><td>梨</td><td>5</td></tr></tbody></table></div>',
    quote: '<div class="md"><blockquote class="md__quote">先说结论</blockquote>\n<p>正文一句 <a href="https://example.com/a" target="_blank" rel="noreferrer noopener">链接</a>。</p></div>',
    inline: '<div class="md"><p>用 <code>npm run build</code> 编译，<strong>别</strong> 直接 <em>删</em> 文件。</p></div>',
    'raw html': '<div class="md"><p>&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;q&quot;</p></div>',
    'unclosed fence': '<div class="md"><pre class="code-box"><code>let a = 1\n\n# 不是标题</code></pre></div>',
  }

  for (const [name, input] of cases) {
    it(name, () => {
      expect(md.renderMarkdown(input)).toBe(snapshots[name])
    })
  }
})

describe('renderDoc headings and toc', () => {
  it('builds real heading levels and collects only h2/h3 into the toc', () => {
    const { html, toc } = md.renderDoc('# 标题\n\n## 目标\n\n### 细节\n\n#### 更深一层')
    expect(html).toContain('<h1 id="标题"')
    expect(html).toContain('<h2 id="目标"')
    expect(html).toContain('<h3 id="细节"')
    expect(html).toContain('<h4 id="更深一层"')
    expect(toc).toEqual([
      { level: 2, id: '目标', text: '目标' },
      { level: 3, id: '细节', text: '细节' },
    ])
  })

  it('keeps Chinese ids stable and deduplicates repeats', () => {
    const first = md.renderDoc('## 目标\n\n## 目标\n\n## 目标')
    const second = md.renderDoc('## 目标\n\n## 目标\n\n## 目标')
    expect(first.toc.map((entry) => entry.id)).toEqual(['目标', '目标-2', '目标-3'])
    expect(second.toc).toEqual(first.toc)
  })

  it('falls back to a non-empty id for headings with only punctuation', () => {
    const { toc } = md.renderDoc('## ！！！\n\n## ！！！')
    expect(toc[0]?.id).toBe('section')
    expect(toc[1]?.id).toBe('section-2')
  })

  it('can turn ids and the toc off', () => {
    const { html, toc } = md.renderDoc('## 目标', { headingIds: false })
    expect(html).not.toContain('id=')
    expect(toc).toEqual([])
  })

  it('renders inline formatting, strikethrough and inline code', () => {
    const { html } = md.renderDoc('**粗** *斜* ~~删~~ `x < y`')
    expect(html).toContain('<strong>粗</strong>')
    expect(html).toContain('<em>斜</em>')
    expect(html).toContain('<del>删</del>')
    expect(html).toContain('<code>x &lt; y</code>')
  })
})

describe('renderDoc lists, tables, quotes, code', () => {
  it('renders nested lists at two and four spaces', () => {
    const two = md.renderDoc('- a\n  - b\n    - c').html
    expect(two.match(/<ul class="md-list">/g)?.length).toBe(3)
    expect(two).toContain('<li>b<ul class="md-list"><li>c</li></ul></li>')

    const four = md.renderDoc('1. a\n    1. b\n        1. c').html
    expect(four.match(/<ol class="md-list">/g)?.length).toBe(3)
  })

  it('renders task list checkboxes disabled with an aria label', () => {
    const { html } = md.renderDoc('- [ ] 未完成\n- [x] 已完成\n- [X] 也完成')
    expect(html).toContain('type="checkbox" disabled')
    expect(html).toContain('aria-label="未完成"')
    expect(html).toContain('checked aria-label="已完成"')
    expect(html.match(/class="md-task"/g)?.length).toBe(3)
  })

  it('recognises table alignment and wraps the table for narrow screens', () => {
    const { html } = md.renderDoc('| 左 | 中 | 右 |\n| :--- | :---: | ---: |\n| a | b | c |')
    expect(html).toContain('<div class="table-wrap"><table class="md-table">')
    expect(html).toContain('<th class="ta-left">左</th>')
    expect(html).toContain('<th class="ta-center">中</th>')
    expect(html).toContain('<th class="ta-right">右</th>')
    expect(html).toContain('<td class="ta-center">b</td>')
  })

  it('nests block quotes', () => {
    const { html } = md.renderDoc('> 外层\n> > 内层')
    expect(html).toContain('<blockquote class="md-quote"><p>外层</p>')
    expect(html).toContain('<blockquote class="md-quote"><p>内层</p></blockquote>')
  })

  it('renders fenced code with a sanitised language and a copy button', () => {
    const { html } = md.renderDoc(fence + 'ts\nconst x = 1\n' + fence)
    expect(html).toContain('<code class="lang-ts">const x = 1</code>')
    expect(html).toContain('data-copy-code')
    const unsafe = md.renderDoc(fence + 'x" onload="alert(1)\n1\n' + fence).html
    expect(unsafe).toContain('<code class="lang-x">')
    expect(unsafe).not.toContain('onload="alert')
    expect(unsafe).not.toContain('class="lang-x" onload')
  })

  it('treats an unclosed fence as running to the end without swallowing it into a heading', () => {
    const { html } = md.renderDoc(fence + 'js\nlet a = 1\n\n# 不是标题')
    expect(html).toContain('<pre class="code-block">')
    expect(html).toContain('# 不是标题')
    expect(html).not.toContain('<h1 id="不是标题"')
  })

  it('renders horizontal rules and paragraphs', () => {
    const { html } = md.renderDoc('第一段\n接着一行\n\n---\n\n第二段')
    expect(html).toContain('<p>第一段 接着一行</p>')
    expect(html).toContain('<hr class="md-hr">')
    expect(html).toContain('<p>第二段</p>')
  })
})

describe('renderDoc links and images', () => {
  it('opens http(s) links in a new tab with noopener', () => {
    const { html } = md.renderDoc('[站点](https://example.com/a?q=1)')
    expect(html).toContain('href="https://example.com/a?q=1" target="_blank" rel="noopener noreferrer"')
  })

  it('does not load external images; shows alt text and a link instead', () => {
    const { html } = md.renderDoc('![架构图](https://example.com/a.png)')
    expect(html).not.toContain('<img')
    expect(html).toContain('架构图</a>')
    expect(html).toContain('href="https://example.com/a.png"')
  })

  it('rewrites relative images through resolveImage and only allows image extensions', () => {
    const seen: string[] = []
    const render = (src: string) => md.renderDoc(`![图](${src})`, {
      resolveImage: (value) => {
        seen.push(value)
        return `api/tickets/T/files?path=output/${value.replace('./', '')}&raw=1`
      },
    }).html
    const png = render('./assets/arch.png')
    expect(seen).toContain('./assets/arch.png')
    expect(png).toContain('<img src="api/tickets/T/files?path=output/assets/arch.png&amp;raw=1"')
    const svg = render('./assets/arch.svg')
    expect(svg).not.toContain('<img')
    expect(svg).toContain('图')
  })

  it('rewrites relative links through resolveLink', () => {
    const { html } = md.renderDoc('[详细设计](./design.md)', {
      resolveLink: (href) => `#/doc/ticket/T?path=output/${href.replace('./', '')}`,
    })
    expect(html).toContain('<a href="#/doc/ticket/T?path=output/design.md">详细设计</a>')
  })

  it('renders a link label when resolution returns null', () => {
    const { html } = md.renderDoc('[详细设计](./design.md)')
    expect(html).not.toContain('<a ')
    expect(html).toContain('详细设计')
  })
})

describe('renderDoc security', () => {
  const unsafe = [
    '<script>window.__xss=1</script>',
    '[x](javascript:alert(1))',
    '![](javascript:alert(1))',
    '<img src=x onerror="window.__xss=1">',
    '[e](java&#115;cript:alert(1))',
    '[m](JaVaScRiPt:alert(1))',
    '[c](javascript&colon;alert(1))',
    '[d](data:text/html,<script>alert(1)</script>)',
    '[f](file:///etc/passwd)',
    '[v](vbscript:msgbox(1))',
  ].join('\n\n')

  it('never emits a script tag, event handler attribute, or executable link', () => {
    const { html } = md.renderDoc(unsafe)
    expect(html).not.toContain('<script')
    expect(html).not.toContain('onerror=')
    expect(html).not.toContain('javascript:')
    expect(html).not.toContain('vbscript:')
    expect(html).not.toContain('data:text/html')
    expect(html).not.toMatch(/href="\s*(?:javascript|data|vbscript|file):/i)
    expect(html).not.toMatch(/<\s*img[^>]*(?:javascript|data):/i)
    expect(html).not.toContain('<img src=x')
  })

  it('keeps dangerous text visible but inert', () => {
    const { html } = md.renderDoc('<script>alert(1)</script>')
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
  })

  it('escapes quotes inside attributes', () => {
    const { html } = md.renderDoc('[x](https://example.com/?q=%22%20onmouseover=%22alert(1))', {})
    expect(html).not.toContain(' onmouseover="alert')
    expect(html).not.toMatch(/<a [^>]*onmouseover=/i)
  })

  it('refuses a quote-injection URL and keeps the label', () => {
    const { html } = md.renderDoc('[x](https://example.com/" onmouseover="alert(1))')
    expect(html).not.toMatch(/<a [^>]*onmouseover=/i)
    expect(html).toContain('x')
  })
})

describe('renderDoc performance', () => {
  it('renders a 100k-character document well under the 1.5s guard', () => {
    const block = '## 章节\n\n- 第一条\n- 第二条\n  - 嵌套\n\n正文里有一段 **粗体** 和 `代码`。\n\n'
    const text = block.repeat(Math.ceil(100_000 / block.length))
    expect(text.length).toBeGreaterThanOrEqual(100_000)
    const started = performance.now()
    const { html, toc } = md.renderDoc(text)
    const elapsed = performance.now() - started
    expect(html.length).toBeGreaterThan(1000)
    expect(toc.length).toBeGreaterThan(0)
    expect(elapsed).toBeLessThan(1500)
  })
})

describe('renderDoc ==highlight==', () => {
  it('renders a basic highlight as mark', () => {
    expect(md.renderDoc('这是 ==重点== 句子').html).toContain('<p>这是 <mark>重点</mark> 句子</p>')
  })

  it('nests with bold and italic', () => {
    expect(md.renderDoc('**==重点==**').html).toContain('<strong><mark>重点</mark></strong>')
    expect(md.renderDoc('==**重点**==').html).toContain('<mark><strong>重点</strong></mark>')
  })

  it('leaves highlight markers inside inline code alone', () => {
    const { html } = md.renderDoc('用 `==x==` 表示')
    expect(html).toContain('<code>==x==</code>')
    expect(html).not.toContain('<mark>')
  })

  it('leaves highlight markers inside fenced code alone', () => {
    const { html } = md.renderDoc(fence + '\n==x==\n' + fence)
    expect(html).toContain('==x==')
    expect(html).not.toContain('<mark>')
  })

  it('keeps comparison, equals and lone markers as plain text', () => {
    for (const input of ['a == b', 'x==y', 'a === b', '====', '== ==', 'if (a == b) {}']) {
      expect(md.renderDoc(input).html).not.toContain('<mark>')
    }
    expect(md.renderDoc('a == b').html).toContain('<p>a == b</p>')
    expect(md.renderDoc('x==y').html).toContain('<p>x==y</p>')
    expect(md.renderDoc('====').html).toContain('<p>====</p>')
  })

  it('escapes script inside a highlight', () => {
    const { html } = md.renderDoc('==<script>alert(1)</script>==')
    expect(html).toContain('<mark>&lt;script&gt;alert(1)&lt;/script&gt;</mark>')
    expect(html).not.toContain('<script')
  })

  it('renders several highlights on one line', () => {
    expect(md.renderDoc('==a== and ==b==').html).toContain('<mark>a</mark> and <mark>b</mark>')
  })

  it('does not match across lines', () => {
    const { html } = md.renderDoc('==a\n==b==')
    expect(html).not.toContain('<mark>a')
  })

  it('keeps the legacy renderMarkdown output free of mark', () => {
    expect(md.renderMarkdown('==x==')).not.toContain('<mark>')
  })

  it('edge cases: adjacent markers, two marks with one space, punctuation inside', () => {
    expect(md.renderDoc('==a==b==').html).toContain('<p><mark>a</mark>b==</p>')
    expect(md.renderDoc('==a== ==b==').html).toContain('<p><mark>a</mark> <mark>b</mark></p>')
    expect(md.renderDoc('==中文，带标点。==').html).toContain('<p><mark>中文，带标点。</mark></p>')
  })

  it('handles 100k repeated opening markers quickly', () => {
    const text = '==a'.repeat(100_000)
    const started = performance.now()
    md.renderDoc(text)
    expect(performance.now() - started).toBeLessThan(1500)
  })
})
