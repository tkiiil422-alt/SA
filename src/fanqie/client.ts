/**
 * Fanqie writer-console client. It acts for the account owner with the Cookie the owner supplied; it never logs in,
 * and it never tries to get past a captcha. An expired Cookie surfaces as FanqieAuthError so the console can ask for a new one.
 */
const ORIGIN = 'https://fanqienovel.com'
const BASE = { aid: '2503', app_name: 'muye_novel' }
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/156.0 Mobile/15E148 Safari/604.1'

export class FanqieAuthError extends Error {}
export class FanqieApiError extends Error { constructor(message: string, readonly code?: number) { super(message) } }

export interface FanqieOptions {
  /** Current Cookie header value. */
  getCookie: () => string
  /** Called with the merged Cookie when the site rotated some cookies, so the login keeps living. */
  saveCookie?: (cookie: string) => void
  fetch?: typeof fetch
}

export interface PublishInput {
  bookId: string
  itemId: string
  title: string
  paragraphs: string[]
  volumeId: string
  volumeName: string
  /** Unix seconds; present means a timed publish. */
  timerTime?: number
  useAi: boolean
}

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const html = (paras: string[]): string => paras.map(p => `<p>${esc(p)}</p>`).join('') + '<p></p>'
const safeTitle = (t: string): string => t.replace(/\s+/g, ' ').replace(/</g, '\uFF1C').replace(/>/g, '\uFF1E').trim()

/** Merge `Set-Cookie` headers into a Cookie header value. */
export function mergeCookies(current: string, setCookies: string[]): string {
  const map = new Map<string, string>()
  for (const part of current.split(';')) { const i = part.indexOf('='); if (i > 0) map.set(part.slice(0, i).trim(), part.slice(i + 1).trim()) }
  for (const line of setCookies) {
    const first = line.split(';')[0] ?? ''
    const i = first.indexOf('=')
    if (i <= 0) continue
    const name = first.slice(0, i).trim(); const value = first.slice(i + 1).trim()
    if (value === '' || /max-age=0/i.test(line)) map.delete(name); else map.set(name, value)
  }
  return [...map].map(([k, v]) => `${k}=${v}`).join('; ')
}

export class FanqieClient {
  constructor(private readonly o: FanqieOptions) {}
  private get f(): typeof fetch { return this.o.fetch ?? fetch }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return { cookie: this.o.getCookie(), 'user-agent': UA, referer: `${ORIGIN}/main/writer/`, origin: ORIGIN, accept: 'application/json, text/plain, */*', ...extra }
  }

  private absorb(res: Response): void {
    try {
      const set = res.headers.getSetCookie?.() ?? []
      if (set.length === 0) return
      const merged = mergeCookies(this.o.getCookie(), set)
      if (merged && merged !== this.o.getCookie()) this.o.saveCookie?.(merged)
    } catch { /* keep-alive is best effort */ }
  }

  private async parse(res: Response): Promise<any> {
    this.absorb(res)
    const text = await res.text()
    let json: any
    try { json = JSON.parse(text) } catch { json = undefined }
    if (res.status === 401 || res.status === 302) throw new FanqieAuthError('番茄登录已失效')
    if (json === undefined) throw new FanqieApiError(`番茄返回了非 JSON（${res.status}）：${text.slice(0, 80)}`)
    if (json.code === 0) return json.data ?? {}
    const msg = String(json.message ?? '')
    if (/login|登录|未登录|session|unauthor/i.test(msg) || json.code === 4001 || json.code === 10008) throw new FanqieAuthError(`番茄登录已失效：${msg}`)
    throw new FanqieApiError(msg || `番茄接口错误 ${json.code}`, json.code)
  }

  async get(path: string, params: Record<string, string> = {}): Promise<any> {
    const res = await this.f(`${ORIGIN}${path}?${new URLSearchParams({ ...params, ...BASE })}`, { headers: this.headers() })
    return this.parse(res)
  }

  async post(path: string, data: Record<string, string>): Promise<any> {
    const url = `${ORIGIN}${path}?${new URLSearchParams(BASE)}`
    const head = await this.f(url, { method: 'HEAD', headers: this.headers({ 'x-secsdk-csrf-request': '1', 'x-secsdk-csrf-version': '1.2.22' }) })
    this.absorb(head)
    const token = (head.headers.get('x-ware-csrf-token') ?? '').split(',')[1] ?? ''
    const res = await this.f(url, {
      method: 'POST',
      headers: this.headers({ 'content-type': 'application/x-www-form-urlencoded;charset=UTF-8', ...(token ? { 'x-secsdk-csrf-token': token } : {}) }),
      body: new URLSearchParams({ ...BASE, ...data }).toString(),
    })
    return this.parse(res)
  }

  /** Cheap authenticated call; throws FanqieAuthError when the Cookie no longer works. */
  async account(): Promise<{ name: string }> {
    const d = await this.get('/api/author/account/info/v0/')
    return { name: String(d.author_name ?? '') }
  }

  async books(): Promise<{ id: string; name: string }[]> {
    const d = await this.get('/api/author/book/book_list/v0', { page_index: '0', page_count: '50' })
    return (d.book_list ?? []).map((b: any) => ({ id: String(b.book_id), name: String(b.book_name ?? '') }))
  }

  async volumes(bookId: string): Promise<{ id: string; name: string }[]> {
    const d = await this.get('/api/author/volume/volume_list/v1', { book_id: bookId })
    return (d.volume_list ?? []).map((v: any) => ({ id: String(v.volume_id), name: String(v.volume_name) }))
  }

  /** Create a chapter slot, or reuse an existing blank draft. */
  async newItem(bookId: string): Promise<{ itemId: string; volumeId: string; volumeName: string }> {
    const d = await this.post('/api/author/article/new_article/v0/', { book_id: bookId, need_reuse: '1' })
    const vol = (d.volume_data ?? [])[0] ?? {}
    return { itemId: String(d.item_id), volumeId: String(vol.volume_id ?? d.volume_id ?? ''), volumeName: String(vol.volume_name ?? '') }
  }

  async saveDraft(i: Omit<PublishInput, 'useAi' | 'timerTime'>): Promise<void> {
    await this.post('/api/author/article/cover_article/v0/', {
      book_id: i.bookId, item_id: i.itemId, title: safeTitle(i.title), content: html(i.paragraphs),
      volume_name: i.volumeName, volume_id: i.volumeId, device_platform: 'pc',
    })
  }

  async publish(i: PublishInput): Promise<void> {
    const timed = i.timerTime !== undefined
    await this.post('/api/author/publish_article/v0/', {
      item_id: i.itemId, book_id: i.bookId, content: html(i.paragraphs), timer_status: timed ? '1' : '0', need_pay: '0',
      volume_name: i.volumeName, volume_id: i.volumeId, title: safeTitle(i.title), timer_time: timed ? String(i.timerTime) : '',
      publish_status: '1', device_platform: 'pc', use_ai: i.useAi ? '1' : '0', timer_chapter_preview: '[]',
      has_chapter_ad: 'false', chapter_ad_types: '',
    })
  }
}
