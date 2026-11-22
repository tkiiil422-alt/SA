/**
 * 浏览器端到端自检模块（`browser_verify`）。
 *
 * 设计原则：
 * - 优先复用开发镜像已安装的可选 Playwright Chromium（`PLAYWRIGHT_BROWSERS_PATH` 或本地 `playwright` 包）；
 * - 若当前轻量主机未安装 Chromium，则自动切换到真实 HTTP + CookieJar + HTML Form/DOM 验证引擎（`http-dom`），
 *   并在返回值中诚实标明 `engine: 'playwright' | 'http-dom'`；
 * - 无论哪种引擎，都严格执行操作步骤与断言，记录控制台/页面错误、快照/截图与失败 trace，
 *   并可一键写入 `GoalService.recordEvidence()` 供目标门禁直接消费（断言失败绝不放行）。
 */
import { randomBytes } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type {
  BrowserVerifyAssertion,
  BrowserVerifyResult,
  BrowserVerifyStep,
} from '../shared/api-types.ts'
import type { GoalService } from '../goal/service.ts'

export type { BrowserVerifyAssertion, BrowserVerifyResult, BrowserVerifyStep }

export interface BrowserVerifyInput {
  url: string
  steps?: BrowserVerifyStep[]
  outputDir: string
  timeoutMs?: number
  /** 为 true 时优先尝试加载 Playwright Chromium（若不可用则自动回退到 http-dom）。默认 true。 */
  preferPlaywright?: boolean
  /** 若提供，验证结果将作为 `kind: 'browser'` 证据自动回填到 GoalService。 */
  ticketId?: string
  criterionId?: string
  artifactVersion?: string
  goals?: Pick<GoalService, 'recordEvidence'>
  fetchImpl?: typeof fetch
}

/** 从简单 HTML 中提取指定 `<input name="...">` 或 `id="..."` 的当前值。 */
function extractInputValue(html: string, key: string): string | undefined {
  const cleanKey = key.replace(/^[#.\[]/, '').replace(/[\]]$/, '')
  const nameMatch = /name\s*=\s*["']?([^"'\s\]]+)["']?/i.exec(key)
  const target = nameMatch ? nameMatch[1]! : cleanKey
  const inputRe = /<(?:input|textarea|select)\b[^>]*>/gi
  for (const m of html.matchAll(inputRe)) {
    const tag = m[0]
    const nAttr = /\bname\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1]
    const idAttr = /\bid\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1]
    if (nAttr === target || idAttr === target) {
      const valAttr = /\bvalue\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1]
      if (valAttr !== undefined) return decodeHtml(valAttr)
      // textarea 正文
      if (/^<textarea/i.test(tag)) {
        const start = (m.index ?? 0) + tag.length
        const end = html.indexOf('</textarea>', start)
        if (end >= 0) return decodeHtml(html.slice(start, end))
      }
      return ''
    }
  }
  return undefined
}

function decodeHtml(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
}

function stripTags(html: string): string {
  return decodeHtml(
    html
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim(),
  )
}

function parseFormMeta(html: string, currentUrl: string): { action: string; method: string; defaults: Record<string, string> } {
  const formMatch = /<form\b([^>]*)>([\s\S]*?)<\/form>/i.exec(html)
  const attrs = formMatch?.[1] ?? ''
  const inner = formMatch?.[2] ?? html
  const rawAction = /\baction\s*=\s*["']([^"']*)["']/i.exec(attrs)?.[1] ?? ''
  const method = (/\bmethod\s*=\s*["']([^"']+)["']/i.exec(attrs)?.[1] ?? 'POST').toUpperCase()
  const action = rawAction ? new URL(rawAction, currentUrl).toString() : currentUrl
  const defaults: Record<string, string> = {}
  for (const m of inner.matchAll(/<input\b[^>]*>/gi)) {
    const tag = m[0]
    const name = /\bname\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1]
    const value = /\bvalue\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1]
    if (name && value !== undefined) defaults[name] = decodeHtml(value)
  }
  return { action, method, defaults }
}

function selectorMatchesHtml(html: string, selector: string): boolean {
  const s = selector.trim()
  if (!s) return false
  if (s.startsWith('#')) {
    const id = s.slice(1)
    return new RegExp(`\\bid\\s*=\\s*["']${escapeRegex(id)}["']`, 'i').test(html)
  }
  if (s.startsWith('.')) {
    const cls = s.slice(1)
    return new RegExp(`\\bclass\\s*=\\s*["'][^"']*\\b${escapeRegex(cls)}\\b[^"']*["']`, 'i').test(html)
  }
  const nameAttr = /name\s*=\s*["']?([^"'\s\]]+)["']?/i.exec(s)?.[1]
  if (nameAttr) {
    return new RegExp(`\\bname\\s*=\\s*["']${escapeRegex(nameAttr)}["']`, 'i').test(html)
  }
  return new RegExp(`<${escapeRegex(s)}\\b`, 'i').test(html)
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function extractFieldKey(step: BrowserVerifyStep): string {
  if (step.name) return step.name.trim()
  const sel = (step.selector ?? '').trim()
  const attr = /name\s*=\s*["']?([^"'\s\]]+)["']?/i.exec(sel)?.[1]
  if (attr) return attr
  if (sel.startsWith('#')) return sel.slice(1)
  return sel
}

/** 尝试动态加载已安装的 Playwright Chromium；未安装或无法启动时返回 undefined。 */
async function tryPlaywrightRun(
  runId: string,
  input: BrowserVerifyInput,
  started: number,
): Promise<BrowserVerifyResult | undefined> {
  if (input.preferPlaywright === false) return undefined
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let pw: any
  for (const modName of ['playwright', 'playwright-core']) {
    try {
      pw = await import(modName)
      if (pw?.chromium) break
    } catch {
      pw = undefined
    }
  }
  if (!pw?.chromium) return undefined

  const timeoutMs = Math.max(2000, Math.min(120_000, input.timeoutMs ?? 20_000))
  const outDir = input.outputDir
  mkdirSync(outDir, { recursive: true })

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let browser: any
  try {
    browser = await pw.chromium.launch({ headless: true, timeout: timeoutMs })
  } catch {
    return undefined
  }

  const assertions: BrowserVerifyAssertion[] = []
  const consoleErrors: string[] = []
  const screenshots: string[] = []
  let statusCode = 0
  let finalUrl = input.url
  let tracePath: string | undefined

  try {
    const context = await browser.newContext()
    await context.tracing.start({ screenshots: true, snapshots: true })
    const page = await context.newPage()
    page.setDefaultTimeout(timeoutMs)
    page.on('console', (msg: { type(): string; text(): string }) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text())
    })
    page.on('pageerror', (err: Error) => {
      consoleErrors.push(err.message || String(err))
    })

    const initialResp = await page.goto(input.url, { waitUntil: 'domcontentloaded', timeout: timeoutMs })
    statusCode = initialResp?.status() ?? 200
    finalUrl = page.url()

    const steps = input.steps ?? []
    for (let i = 0; i < steps.length; i += 1) {
      const step = steps[i]!
      try {
        if (step.action === 'goto') {
          const target = step.url ? new URL(step.url, finalUrl).toString() : input.url
          const resp = await page.goto(target, { waitUntil: 'domcontentloaded', timeout: timeoutMs })
          statusCode = resp?.status() ?? 200
          finalUrl = page.url()
          assertions.push({ stepIndex: i, action: 'goto', passed: statusCode < 400, detail: `打开 ${finalUrl} (HTTP ${statusCode})` })
        } else if (step.action === 'fill') {
          const sel = step.selector || (step.name ? `[name="${step.name}"]` : '')
          await page.fill(sel, step.value ?? '')
          assertions.push({ stepIndex: i, action: 'fill', passed: true, detail: `填写 ${sel}` })
        } else if (step.action === 'click' || step.action === 'submit') {
          const sel = step.selector || (step.action === 'submit' ? 'button[type="submit"], input[type="submit"], button' : '')
          await Promise.all([
            page.waitForLoadState('domcontentloaded').catch(() => undefined),
            page.click(sel),
          ])
          finalUrl = page.url()
          assertions.push({ stepIndex: i, action: step.action, passed: true, detail: `点击 ${sel}` })
        } else if (step.action === 'reload') {
          const resp = await page.reload({ waitUntil: 'domcontentloaded', timeout: timeoutMs })
          statusCode = resp?.status() ?? statusCode
          finalUrl = page.url()
          assertions.push({ stepIndex: i, action: 'reload', passed: statusCode < 400, detail: `刷新页面 (HTTP ${statusCode})` })
        } else if (step.action === 'wait') {
          await page.waitForTimeout(Math.min(10_000, Math.max(50, step.ms ?? 300)))
          assertions.push({ stepIndex: i, action: 'wait', passed: true, detail: `等待 ${step.ms ?? 300}ms` })
        } else if (step.action === 'assertText') {
          const expected = step.text ?? ''
          const content = step.selector ? await page.textContent(step.selector) : await page.textContent('body')
          const ok = Boolean(content && content.includes(expected))
          assertions.push({ stepIndex: i, action: 'assertText', passed: ok, detail: ok ? `命中文本「${expected}」` : `未在页面找到期望文本「${expected}」` })
        } else if (step.action === 'assertNotText') {
          const forbidden = step.text ?? ''
          const content = step.selector ? await page.textContent(step.selector) : await page.textContent('body')
          const ok = !content || !content.includes(forbidden)
          assertions.push({ stepIndex: i, action: 'assertNotText', passed: ok, detail: ok ? `确认不含文本「${forbidden}」` : `页面意外包含禁止文本「${forbidden}」` })
        } else if (step.action === 'assertVisible') {
          const sel = step.selector ?? 'body'
          const ok = await page.isVisible(sel)
          assertions.push({ stepIndex: i, action: 'assertVisible', passed: ok, detail: ok ? `元素 ${sel} 可见` : `元素 ${sel} 不可见` })
        } else if (step.action === 'assertValue') {
          const sel = step.selector || (step.name ? `[name="${step.name}"]` : '')
          const actual = await page.inputValue(sel)
          const expected = step.value ?? ''
          const ok = actual === expected
          assertions.push({ stepIndex: i, action: 'assertValue', passed: ok, detail: ok ? `${sel} 值等于「${expected}」` : `${sel} 实际值「${actual}」≠ 期望「${expected}」` })
        } else if (step.action === 'assertStatus') {
          const expected = step.status ?? 200
          const ok = statusCode === expected
          assertions.push({ stepIndex: i, action: 'assertStatus', passed: ok, detail: `HTTP 状态码 ${statusCode}（期望 ${expected}）` })
        }
      } catch (error) {
        assertions.push({
          stepIndex: i,
          action: step.action,
          passed: false,
          detail: `步骤执行失败：${error instanceof Error ? error.message : String(error)}`,
        })
      }
    }

    const shot = join(outDir, `${runId}-final.png`)
    try {
      await page.screenshot({ path: shot, fullPage: true })
      screenshots.push(shot)
    } catch { /* best effort */ }

    const allPassed = statusCode < 400 && consoleErrors.length === 0 && assertions.every(a => a.passed)
    if (!allPassed) {
      tracePath = join(outDir, `${runId}-trace.zip`)
      await context.tracing.stop({ path: tracePath }).catch(() => { tracePath = undefined })
    } else {
      await context.tracing.stop().catch(() => undefined)
    }

    const failed = assertions.filter(a => !a.passed)
    const summary = allPassed
      ? `Playwright 自检通过：${assertions.length} 项断言全部通过（HTTP ${statusCode}，无控制台错误）`
      : `Playwright 自检失败：${failed.map(f => f.detail).concat(consoleErrors.map(e => `控制台错误: ${e}`)).slice(0, 3).join('；')}`

    return {
      runId,
      ok: allPassed,
      engine: 'playwright',
      url: input.url,
      finalUrl,
      statusCode,
      assertions,
      consoleErrors,
      screenshots,
      ...(tracePath ? { tracePath } : {}),
      durationMs: Date.now() - started,
      summary,
    }
  } finally {
    await browser.close().catch(() => undefined)
  }
}

/** 轻量真实 HTTP + Form + Cookie + HTML 断言驱动（用于无 Chromium 的小主机与可重复集成测试）。 */
async function runHttpDomVerify(
  runId: string,
  input: BrowserVerifyInput,
  started: number,
): Promise<BrowserVerifyResult> {
  const doFetch = input.fetchImpl ?? globalThis.fetch.bind(globalThis)
  const timeoutMs = Math.max(2000, Math.min(60_000, input.timeoutMs ?? 15_000))
  const outDir = input.outputDir
  mkdirSync(outDir, { recursive: true })

  const cookies = new Map<string, string>()
  const formValues: Record<string, string> = {}
  const assertions: BrowserVerifyAssertion[] = []
  const consoleErrors: string[] = []
  const screenshots: string[] = []
  const traceEvents: Record<string, unknown>[] = []

  let currentUrl = input.url
  let statusCode = 0
  let html = ''

  const cookieHeader = (): string => [...cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ')

  const captureCookies = (resp: Response): void => {
    const rawList = typeof resp.headers.getSetCookie === 'function'
      ? resp.headers.getSetCookie()
      : (resp.headers.get('set-cookie') ? [resp.headers.get('set-cookie')!] : [])
    for (const raw of rawList) {
      const pair = raw.split(';')[0]?.trim()
      if (!pair) continue
      const eq = pair.indexOf('=')
      if (eq > 0) cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim())
    }
  }

  const requestPage = async (url: string, init: RequestInit = {}): Promise<void> => {
    let target = url
    let method = (init.method ?? 'GET').toUpperCase()
    let body = init.body
    let extraHeaders = (init.headers ?? {}) as Record<string, string>

    // 手动处理最多 5 跳重定向以保留每跳 Set-Cookie
    for (let hop = 0; hop < 5; hop += 1) {
      const ctl = new AbortController()
      const timer = setTimeout(() => ctl.abort(), timeoutMs)
      try {
        const hdrs: Record<string, string> = {
          'user-agent': 'SuperAgent-BrowserVerify/2.1',
          ...extraHeaders,
          ...(cookies.size > 0 ? { cookie: cookieHeader() } : {}),
        }
        const resp = await doFetch(target, { method, body: body ?? null, headers: hdrs, redirect: 'manual', signal: ctl.signal })
        captureCookies(resp)
        statusCode = resp.status
        const loc = resp.headers.get('location')
        if (loc && statusCode >= 300 && statusCode < 400) {
          target = new URL(loc, target).toString()
          method = 'GET'
          body = undefined
          extraHeaders = {}
          continue
        }
        currentUrl = target
        html = await resp.text()
        traceEvents.push({ at: new Date().toISOString(), method, url: currentUrl, statusCode, bytes: html.length })
        // 检测服务端页面内嵌控制台错误标记（例如 data-console-error="..."）
        for (const m of html.matchAll(/data-console-error\s*=\s*["']([^"']+)["']/gi)) {
          if (m[1]) consoleErrors.push(decodeHtml(m[1]))
        }
        return
      } finally {
        clearTimeout(timer)
      }
    }
  }

  try {
    await requestPage(input.url)
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    assertions.push({ stepIndex: -1, action: 'goto', passed: false, detail: `无法访问 ${input.url}：${msg}` })
  }

  const steps = input.steps ?? []
  for (let i = 0; i < steps.length; i += 1) {
    const step = steps[i]!
    try {
      if (step.action === 'goto') {
        const target = step.url ? new URL(step.url, currentUrl).toString() : input.url
        await requestPage(target)
        assertions.push({ stepIndex: i, action: 'goto', passed: statusCode > 0 && statusCode < 400, detail: `打开 ${currentUrl} (HTTP ${statusCode})` })
      } else if (step.action === 'fill') {
        const key = extractFieldKey(step)
        if (!key) throw new Error('fill 缺少 selector 或 name')
        formValues[key] = step.value ?? ''
        assertions.push({ stepIndex: i, action: 'fill', passed: true, detail: `填写字段 ${key}` })
      } else if (step.action === 'submit' || step.action === 'click') {
        const meta = parseFormMeta(html, currentUrl)
        const payload = new URLSearchParams({ ...meta.defaults, ...formValues })
        if (meta.method === 'GET') {
          const u = new URL(meta.action)
          for (const [k, v] of payload.entries()) u.searchParams.set(k, v)
          await requestPage(u.toString(), { method: 'GET' })
        } else {
          await requestPage(meta.action, {
            method: meta.method,
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: payload.toString(),
          })
        }
        assertions.push({ stepIndex: i, action: step.action, passed: statusCode > 0 && statusCode < 400, detail: `提交表单至 ${meta.action} (HTTP ${statusCode})` })
      } else if (step.action === 'reload') {
        await requestPage(currentUrl, { method: 'GET' })
        assertions.push({ stepIndex: i, action: 'reload', passed: statusCode > 0 && statusCode < 400, detail: `刷新页面 ${currentUrl} (HTTP ${statusCode})` })
      } else if (step.action === 'wait') {
        const ms = Math.min(5000, Math.max(10, step.ms ?? 50))
        await new Promise(r => setTimeout(r, ms))
        assertions.push({ stepIndex: i, action: 'wait', passed: true, detail: `等待 ${ms}ms` })
      } else if (step.action === 'assertText') {
        const expected = step.text ?? ''
        const plain = stripTags(html)
        const ok = plain.includes(expected) || html.includes(expected)
        assertions.push({ stepIndex: i, action: 'assertText', passed: ok, detail: ok ? `命中文本「${expected}」` : `未在页面找到期望文本「${expected}」` })
      } else if (step.action === 'assertNotText') {
        const forbidden = step.text ?? ''
        const plain = stripTags(html)
        const ok = !plain.includes(forbidden) && !html.includes(forbidden)
        assertions.push({ stepIndex: i, action: 'assertNotText', passed: ok, detail: ok ? `确认不含文本「${forbidden}」` : `页面意外出现文本「${forbidden}」` })
      } else if (step.action === 'assertVisible') {
        const sel = step.selector ?? 'body'
        const ok = selectorMatchesHtml(html, sel)
        assertions.push({ stepIndex: i, action: 'assertVisible', passed: ok, detail: ok ? `元素 ${sel} 存在` : `页面未找到元素 ${sel}` })
      } else if (step.action === 'assertValue') {
        const key = extractFieldKey(step)
        const actual = extractInputValue(html, key)
        const expected = step.value ?? ''
        const ok = actual === expected
        assertions.push({ stepIndex: i, action: 'assertValue', passed: ok, detail: ok ? `字段 ${key} 值等于「${expected}」` : `字段 ${key} 实际值「${actual ?? '(缺失)'}」≠ 期望「${expected}」` })
      } else if (step.action === 'assertStatus') {
        const expected = step.status ?? 200
        const ok = statusCode === expected
        assertions.push({ stepIndex: i, action: 'assertStatus', passed: ok, detail: `HTTP 状态码 ${statusCode}（期望 ${expected}）` })
      }
    } catch (error) {
      assertions.push({
        stepIndex: i,
        action: step.action,
        passed: false,
        detail: `步骤异常：${error instanceof Error ? error.message : String(error)}`,
      })
    }
  }

  const snapPath = join(outDir, `${runId}-snapshot.html`)
  writeFileSync(snapPath, html, 'utf8')
  screenshots.push(snapPath)

  const allPassed = statusCode > 0 && statusCode < 400 && consoleErrors.length === 0 && assertions.every(a => a.passed)
  let tracePath: string | undefined
  if (!allPassed) {
    tracePath = join(outDir, `${runId}-trace.json`)
    writeFileSync(
      tracePath,
      JSON.stringify({ runId, url: input.url, finalUrl: currentUrl, statusCode, assertions, consoleErrors, traceEvents, htmlSnippet: html.slice(0, 4000) }, null, 2),
      'utf8',
    )
  }

  const failed = assertions.filter(a => !a.passed)
  const summary = allPassed
    ? `浏览器自检（http-dom）通过：${assertions.length} 项断言全部通过（HTTP ${statusCode}，无错误）`
    : `浏览器自检（http-dom）失败：${failed.map(f => f.detail).concat(consoleErrors.map(e => `页面错误: ${e}`)).slice(0, 3).join('；')}`

  return {
    runId,
    ok: allPassed,
    engine: 'http-dom',
    url: input.url,
    finalUrl: currentUrl,
    statusCode,
    assertions,
    consoleErrors,
    screenshots,
    ...(tracePath ? { tracePath } : {}),
    durationMs: Date.now() - started,
    summary,
  }
}

/** 运行一次完整的 `browser_verify`，并按需将客观结果自动写入 `GoalService`。 */
export async function runBrowserVerify(input: BrowserVerifyInput): Promise<BrowserVerifyResult> {
  const started = Date.now()
  const runId = `bv_${randomBytes(4).toString('hex')}`
  const pwResult = await tryPlaywrightRun(runId, input, started)
  const result = pwResult ?? await runHttpDomVerify(runId, input, started)

  if (input.goals && input.ticketId) {
    input.goals.recordEvidence(input.ticketId, {
      kind: 'browser',
      ...(input.criterionId ? { criterionId: input.criterionId } : {}),
      runId: result.runId,
      artifactVersion: input.artifactVersion || 'working-tree',
      passed: result.ok,
      summary: result.summary,
      detail: JSON.stringify({
        engine: result.engine,
        finalUrl: result.finalUrl,
        statusCode: result.statusCode,
        assertions: result.assertions,
        consoleErrors: result.consoleErrors,
        screenshots: result.screenshots,
        tracePath: result.tracePath,
      }),
    })
  }

  return result
}
