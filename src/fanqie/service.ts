/**
 * Fanqie publishing: which local chapters went to the writer console, as a draft or published, and a keep-alive check of
 * the owner's Cookie. Sync runs one chapter at a time with a pause between chapters; any auth failure stops the run and
 * flags the Cookie as expired so the console asks the owner for a new one.
 */
import type { DatabaseSync } from 'node:sqlite'
import { FanqieApiError, FanqieAuthError, FanqieClient, type FanqieOptions } from './client.ts'

const SECRET = 'FANQIE_COOKIE'

export interface FanqieVault {
  has(name: string): boolean
  reveal(name: string): string
  update(name: string, patch: { value?: string }): void
}
export interface FanqieNovels {
  detail(bookId: string): { chapters: { n: number; title: string; status: string; sha256: string }[] }
  chapter(bookId: string, n: number): { text: string }
}
export type SyncMode = 'draft' | 'publish' | 'timer'
export interface SyncRequest { bookId: string; chapters: number[]; mode: SyncMode; timerTime?: number; useAi: boolean }
export interface JobView { running: boolean; total: number; done: number; failed: number; current?: number; error?: string; startedAt: string }

export interface FanqieServiceOptions {
  db: DatabaseSync
  vault: FanqieVault
  novels: FanqieNovels
  event?: (kind: string, level: 'info' | 'warn', text: string) => void
  /** Pause between chapters in ms (default 4000). */
  delayMs?: number
  makeClient?: (o: FanqieOptions) => Pick<FanqieClient, 'account' | 'books' | 'volumes' | 'newItem' | 'saveDraft' | 'publish'>
  now?: () => Date
}

export class FanqieService {
  private readonly o: FanqieServiceOptions
  private job: JobView | undefined
  private expired = false
  private lastCheck: { at: string; ok: boolean; name?: string; error?: string } | undefined

  constructor(options: FanqieServiceOptions) {
    this.o = options
    options.db.exec(`CREATE TABLE IF NOT EXISTS fanqie_books (book_id TEXT PRIMARY KEY, fq_book_id TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS fanqie_sync (book_id TEXT NOT NULL, n INTEGER NOT NULL, item_id TEXT NOT NULL, state TEXT NOT NULL,
        sha256 TEXT NOT NULL, error TEXT, updated_at TEXT NOT NULL, PRIMARY KEY (book_id, n))`)
  }

  private now(): string { return (this.o.now?.() ?? new Date()).toISOString() }
  private client() {
    const make = this.o.makeClient ?? ((x: FanqieOptions) => new FanqieClient(x))
    return make({ getCookie: () => this.o.vault.reveal(SECRET), saveCookie: c => { try { this.o.vault.update(SECRET, { value: c }) } catch { /* best effort */ } } })
  }
  private flagExpired(why: string): void {
    if (!this.expired) this.o.event?.('fanqie.expired', 'warn', `番茄登录已失效，请重新填写 Cookie（${why}）`)
    this.expired = true
  }

  hasCookie(): boolean { return this.o.vault.has(SECRET) }

  /** Keep-alive: one cheap authenticated call; the client also stores any rotated cookies. */
  async check(): Promise<{ ok: boolean; name?: string; error?: string; expired: boolean }> {
    if (!this.hasCookie()) return { ok: false, error: '还没有填写 FANQIE_COOKIE', expired: false }
    try {
      const a = await this.client().account()
      this.expired = false
      this.lastCheck = { at: this.now(), ok: true, name: a.name }
      return { ok: true, name: a.name, expired: false }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (e instanceof FanqieAuthError) this.flagExpired(msg)
      this.lastCheck = { at: this.now(), ok: false, error: msg }
      return { ok: false, error: msg, expired: this.expired }
    }
  }

  status() {
    return { hasCookie: this.hasCookie(), expired: this.expired, lastCheck: this.lastCheck, job: this.job }
  }

  remoteBooks() { return this.client().books() }

  bind(bookId: string, fqBookId: string): void {
    this.o.db.prepare('INSERT INTO fanqie_books (book_id, fq_book_id, updated_at) VALUES (?,?,?) ON CONFLICT(book_id) DO UPDATE SET fq_book_id=excluded.fq_book_id, updated_at=excluded.updated_at')
      .run(bookId, fqBookId, this.now())
  }
  boundTo(bookId: string): string | undefined {
    return (this.o.db.prepare('SELECT fq_book_id AS id FROM fanqie_books WHERE book_id=?').get(bookId) as { id: string } | undefined)?.id
  }

  list(bookId: string) {
    const rows = this.o.db.prepare('SELECT n, item_id, state, sha256, error, updated_at FROM fanqie_sync WHERE book_id=?').all(bookId) as { n: number; item_id: string; state: string; sha256: string; error: string | null; updated_at: string }[]
    const byN = new Map(rows.map(r => [r.n, r]))
    return this.o.novels.detail(bookId).chapters.map(c => {
      const r = byN.get(c.n)
      const state = !r ? 'none' : r.state === 'failed' ? 'failed' : r.sha256 !== c.sha256 ? 'changed' : r.state
      return { n: c.n, title: c.title, flagged: c.status === 'flagged', state, error: r?.error ?? undefined, syncedAt: r?.updated_at }
    })
  }

  start(req: SyncRequest): JobView {
    if (this.job?.running) throw new Error('已有一个同步任务在进行')
    const fq = this.boundTo(req.bookId)
    if (!fq) throw new Error('这本书还没有绑定番茄作品')
    if (!this.hasCookie()) throw new Error('还没有填写 FANQIE_COOKIE')
    if (req.mode === 'timer' && !(req.timerTime && req.timerTime * 1000 > Date.now() + 30 * 60_000)) throw new Error('定时发布的时间要晚于现在 30 分钟以上')
    const chapters = [...new Set(req.chapters)].sort((a, b) => a - b)
    if (!chapters.length) throw new Error('请至少选一章')
    const job: JobView = { running: true, total: chapters.length, done: 0, failed: 0, startedAt: this.now() }
    this.job = job
    void this.run(req, fq, chapters, job)
    return job
  }

  private async run(req: SyncRequest, fq: string, chapters: number[], job: JobView): Promise<void> {
    const client = this.client()
    const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))
    try {
      const rows = new Map(this.o.novels.detail(req.bookId).chapters.map(c => [c.n, c]))
      for (const [index, n] of chapters.entries()) {
        job.current = n
        const meta = rows.get(n)
        const prev = this.o.db.prepare('SELECT item_id, state FROM fanqie_sync WHERE book_id=? AND n=?').get(req.bookId, n) as { item_id: string; state: string } | undefined
        try {
          if (!meta) throw new FanqieApiError('本地没有这一章')
          if (prev?.state === 'published') throw new FanqieApiError('这一章已经发布，番茄不允许从这里重复发布')
          const text = this.o.novels.chapter(req.bookId, n).text
          const paragraphs = text.split(/\n+/).map(s => s.trim()).filter(Boolean)
          const slot = prev?.item_id ? { itemId: prev.item_id, ...(await this.volume(client, fq)) } : await client.newItem(fq)
          const base = { bookId: fq, itemId: slot.itemId, title: `第${n}章 ${meta.title}`.replace(/^第\d+章 第\d+章/, `第${n}章`), paragraphs, volumeId: slot.volumeId, volumeName: slot.volumeName }
          if (req.mode === 'draft') await client.saveDraft(base)
          else await client.publish({ ...base, useAi: req.useAi, ...(req.mode === 'timer' ? { timerTime: req.timerTime } : {}) })
          this.record(req.bookId, n, slot.itemId, req.mode === 'draft' ? 'draft' : req.mode === 'timer' ? 'scheduled' : 'published', meta.sha256, null)
          job.done += 1
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e)
          if (e instanceof FanqieAuthError) { this.flagExpired(msg); job.error = '登录已失效，请重新填写 Cookie'; break }
          this.record(req.bookId, n, prev?.item_id ?? '', 'failed', '', msg)
          job.failed += 1
        }
        if (index < chapters.length - 1) await sleep(this.o.delayMs ?? 4000)
      }
    } finally {
      job.running = false
      job.current = undefined
      this.o.event?.('fanqie.sync', job.failed || job.error ? 'warn' : 'info', `番茄同步结束：成功 ${job.done}，失败 ${job.failed}${job.error ? `，${job.error}` : ''}`)
    }
  }

  private async volume(client: ReturnType<FanqieService['client']>, fq: string) {
    const v = (await client.volumes(fq))[0]
    return { volumeId: v?.id ?? '', volumeName: v?.name ?? '' }
  }

  private record(bookId: string, n: number, itemId: string, state: string, sha: string, error: string | null): void {
    this.o.db.prepare('INSERT INTO fanqie_sync (book_id,n,item_id,state,sha256,error,updated_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(book_id,n) DO UPDATE SET item_id=excluded.item_id,state=excluded.state,sha256=excluded.sha256,error=excluded.error,updated_at=excluded.updated_at')
      .run(bookId, n, itemId, state, sha, error, this.now())
  }
}
