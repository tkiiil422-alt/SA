import { Component, Fragment, useEffect, useState, type ReactNode } from 'react'

/** Shared UI primitives: toast, modal confirm/prompt, busy-guarded actions, sheets, safe Markdown, theme & media hooks. */
let pushToast: (text: string, bad?: boolean) => void = () => {}
export const toast = (text: string, bad = false) => pushToast(text, bad)
export function ToastHost() {
  const [t, setT] = useState<{ text: string; bad: boolean; n: number } | null>(null)
  useEffect(() => { pushToast = (text, bad = false) => setT({ text, bad, n: Date.now() }) }, [])
  useEffect(() => { if (!t) return; const x = setTimeout(() => setT(null), 2800); return () => clearTimeout(x) }, [t])
  return t ? <p className={t.bad ? 'toast bad' : 'toast'} role="status">{t.text}</p> : null
}

/** Accessible in-app confirm & prompt dialogs (replaces native confirm/prompt which break on mobile WebViews). */
type DialogRequest =
  | { kind: 'confirm'; title: string; message: string; danger?: boolean; okLabel?: string; resolve: (v: boolean) => void }
  | { kind: 'prompt'; title: string; message: string; placeholder?: string; defaultValue?: string; okLabel?: string; resolve: (v: string | null) => void }

let pushDialog: (req: DialogRequest) => void = req => {
  if (req.kind === 'confirm') req.resolve(typeof window.confirm === 'function' ? window.confirm(req.message) : true)
  else req.resolve(typeof window.prompt === 'function' ? window.prompt(req.message, req.defaultValue ?? '') : null)
}

export function confirmAction(message: string, opts: { title?: string; danger?: boolean; okLabel?: string } = {}): Promise<boolean> {
  return new Promise(resolve => pushDialog({
    kind: 'confirm',
    title: opts.title ?? '确认操作',
    message,
    danger: opts.danger,
    okLabel: opts.okLabel ?? '确认',
    resolve,
  }))
}

export function promptAction(message: string, opts: { title?: string; placeholder?: string; defaultValue?: string; okLabel?: string } = {}): Promise<string | null> {
  return new Promise(resolve => pushDialog({
    kind: 'prompt',
    title: opts.title ?? '输入内容',
    message,
    placeholder: opts.placeholder,
    defaultValue: opts.defaultValue ?? '',
    okLabel: opts.okLabel ?? '确定',
    resolve,
  }))
}

export function DialogHost() {
  const [req, setReq] = useState<DialogRequest | null>(null)
  const [val, setVal] = useState('')
  useEffect(() => {
    pushDialog = next => {
      setVal(next.kind === 'prompt' ? (next.defaultValue ?? '') : '')
      setReq(next)
    }
  }, [])
  if (!req) return null
  const close = () => {
    const cur = req
    setReq(null)
    if (cur.kind === 'confirm') cur.resolve(false)
    else cur.resolve(null)
  }
  const accept = () => {
    const cur = req
    setReq(null)
    if (cur.kind === 'confirm') cur.resolve(true)
    else cur.resolve(val)
  }
  return <Sheet title={req.title} onClose={close}>
    <p className="dialog__msg">{req.message}</p>
    {req.kind === 'prompt' && <input
      className="search"
      value={val}
      placeholder={req.placeholder || ''}
      autoFocus
      onChange={e => setVal(e.target.value)}
      onKeyDown={e => { if (e.key === 'Enter') accept() }}
    />}
    <div className="actions dialog__actions">
      <button type="button" onClick={close}>取消</button>
      <button type="button" className={req.kind === 'confirm' && req.danger ? 'primary danger-bg' : 'primary'} onClick={accept}>{req.okLabel || '确定'}</button>
    </div>
  </Sheet>
}

/** React error boundary so malformed URLs or unexpected responses never blank out the console. */
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null }
  static getDerivedStateFromError(error: Error) { return { error } }
  render() {
    if (!this.state.error) return this.props.children
    return <main className="errpage">
      <div className="card">
        <h1>页面出了点问题</h1>
        <p className="meta">{this.state.error.message || '渲染异常'}</p>
        <div className="actions">
          <button className="primary" onClick={() => { this.setState({ error: null }); location.hash = '#/today' }}>回到首页</button>
          <button onClick={() => location.reload()}>刷新页面</button>
        </div>
      </div>
    </main>
  }
}

/** Runs an action once at a time and reports the outcome as a toast. */
export function useAction() {
  const [busy, setBusy] = useState(false)
  const run = async (fn: () => Promise<unknown>, ok?: string, after?: () => void): Promise<boolean> => {
    if (busy) return false
    setBusy(true)
    try { await fn(); if (ok) toast(ok); after?.(); return true } catch (e: any) { toast('失败：' + (e?.message || e), true); return false } finally { setBusy(false) }
  }
  return { busy, run }
}

export function Sheet({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  useEffect(() => { const f = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }; addEventListener('keydown', f); return () => removeEventListener('keydown', f) }, [onClose])
  return <div className="sheet" onClick={e => { if (e.target === e.currentTarget) onClose() }}>
    <div className="sheet__body" role="dialog" aria-label={title}>
      <div className="sheet__head"><b>{title}</b><button type="button" className="ghost" onClick={onClose} aria-label="关闭">✕</button></div>
      {children}
    </div>
  </div>
}

export function Empty({ children }: { children: ReactNode }) { return <p className="empty">{children}</p> }

export function Tabs({ value, onChange, items }: { value: string; onChange: (v: string) => void; items: [string, string][] }) {
  return <div className="seg" role="tablist">{items.map(([k, n]) => <button key={k} type="button" role="tab" aria-pressed={value === k} aria-selected={value === k} onClick={() => onChange(k)}>{n}</button>)}</div>
}

export const bytes = (n?: number) => typeof n !== 'number' ? '' : n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : n < 1073741824 ? `${(n / 1048576).toFixed(1)} MB` : `${(n / 1073741824).toFixed(2)} GB`

export function safeDecode(s: string): string {
  try { return decodeURIComponent(s) } catch { return s }
}

/**
 * CSP-safe inline SVG QR renderer: decodes `data:image/svg+xml;base64,...` into pure React `<svg>` elements
 * without `<img src="data:...">` (blocked by `default-src 'self'`) and without `dangerouslySetInnerHTML`.
 */
export function QrSvg({ dataUrl, size = 220, alt = '扫码二维码' }: { dataUrl?: string; size?: number; alt?: string }) {
  if (!dataUrl) return null
  const prefix = 'data:image/svg+xml;base64,'
  if (!dataUrl.startsWith(prefix)) return null
  let xml = ''
  try {
    xml = atob(dataUrl.slice(prefix.length).trim())
  } catch {
    return null
  }
  const vb = /viewBox="0 0 (\d+) (\d+)"/.exec(xml)
  const pathMatch = /<path d="([MLHVZmlhvz0-9.,\s-]+)"/.exec(xml)
  if (!vb || !pathMatch) return null
  const w = Number(vb[1])
  const h = Number(vb[2])
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return null
  return <svg
    role="img"
    aria-label={alt}
    width={size}
    height={size}
    viewBox={`0 0 ${w} ${h}`}
    shapeRendering="crispEdges"
    style={{ width: size, height: size, borderRadius: 8, border: '1px solid var(--line, #e2e8f0)', background: '#fff', padding: 8, display: 'inline-block' }}
  >
    <rect width={w} height={h} fill="#ffffff" />
    <path d={pathMatch[1]} fill="#000000" />
  </svg>
}

/** Reactive matchMedia hook so PC/mobile layouts update cleanly on window resize or tablet rotation. */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => typeof window.matchMedia === 'function' ? window.matchMedia(query).matches : false)
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return
    const mq = window.matchMedia(query)
    const onChange = () => setMatches(mq.matches)
    onChange()
    if (typeof mq.addEventListener === 'function') {
      mq.addEventListener('change', onChange)
      return () => mq.removeEventListener('change', onChange)
    }
    mq.addListener?.(onChange)
    return () => mq.removeListener?.(onChange)
  }, [query])
  return matches
}

export type ThemeMode = 'system' | 'light' | 'dark'
const THEME_KEY = 'sa-theme'

export function useTheme(): { mode: ThemeMode; dark: boolean; cycle: () => void } {
  const systemDark = useMediaQuery('(prefers-color-scheme: dark)')
  const [mode, setMode] = useState<ThemeMode>(() => {
    try {
      const saved = localStorage.getItem(THEME_KEY)
      return saved === 'light' || saved === 'dark' ? saved : 'system'
    } catch { return 'system' }
  })
  const dark = mode === 'dark' || (mode === 'system' && systemDark)
  useEffect(() => {
    if (mode === 'system') document.documentElement.removeAttribute('data-theme')
    else document.documentElement.setAttribute('data-theme', mode)
    try { localStorage.setItem(THEME_KEY, mode) } catch { /* ignore */ }
  }, [mode])
  const cycle = () => setMode(prev => prev === 'system' ? (systemDark ? 'light' : 'dark') : prev === 'dark' ? 'light' : 'dark')
  return { mode, dark, cycle }
}

/** Safe, dependency-free Markdown renderer (no dangerouslySetInnerHTML) for AI reports & pentest PoCs. */
function renderInline(line: string): ReactNode[] {
  const out: ReactNode[] = []
  const re = /(`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\(https?:\/\/[^)]+\))/g
  let last = 0
  let m: RegExpExecArray | null
  let key = 0
  while ((m = re.exec(line)) !== null) {
    if (m.index > last) out.push(line.slice(last, m.index))
    const token = m[0]!
    if (token.startsWith('`')) out.push(<code key={key++}>{token.slice(1, -1)}</code>)
    else if (token.startsWith('**')) out.push(<strong key={key++}>{token.slice(2, -2)}</strong>)
    else {
      const link = /^\[([^\]]+)\]\((https?:\/\/[^)]+)\)$/.exec(token)
      if (link) out.push(<a key={key++} href={link[2]} target="_blank" rel="noopener noreferrer">{link[1]}</a>)
      else out.push(token)
    }
    last = m.index + token.length
  }
  if (last < line.length) out.push(line.slice(last))
  return out
}

export function Markdown({ text }: { text: string }) {
  const lines = String(text || '').replace(/\r\n/g, '\n').split('\n')
  const nodes: ReactNode[] = []
  let i = 0
  let k = 0
  while (i < lines.length) {
    const line = lines[i]!
    if (line.trimStart().startsWith('```')) {
      const lang = line.trim().slice(3).trim()
      const buf: string[] = []
      i += 1
      while (i < lines.length && !lines[i]!.trimStart().startsWith('```')) { buf.push(lines[i]!); i += 1 }
      i += 1
      const code = buf.join('\n')
      nodes.push(<div className="md__code" key={k++}>
        <div className="md__codebar"><span>{lang || 'code'}</span>
          <button type="button" className="ghost small" onClick={() => navigator.clipboard?.writeText(code).then(() => toast('已复制代码'), () => toast('复制失败', true))}>复制</button>
        </div>
        <pre>{code}</pre>
      </div>)
      continue
    }
    if (!line.trim()) { i += 1; continue }
    const heading = /^(#{1,4})\s+(.+)$/.exec(line)
    if (heading) {
      const lv = heading[1]!.length
      const content = renderInline(heading[2]!)
      nodes.push(lv === 1 ? <h2 key={k++}>{content}</h2> : lv === 2 ? <h3 key={k++}>{content}</h3> : <h4 key={k++}>{content}</h4>)
      i += 1
      continue
    }
    if (line.trimStart().startsWith('>')) {
      const q: string[] = []
      while (i < lines.length && lines[i]!.trimStart().startsWith('>')) {
        q.push(lines[i]!.replace(/^\s*>\s?/, ''))
        i += 1
      }
      nodes.push(<blockquote key={k++}>{q.map((l, idx) => <Fragment key={idx}>{idx > 0 && <br />}{renderInline(l)}</Fragment>)}</blockquote>)
      continue
    }
    if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = []
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i]!)) { items.push(lines[i]!.replace(/^\s*[-*]\s+/, '')); i += 1 }
      nodes.push(<ul key={k++}>{items.map((it, idx) => <li key={idx}>{renderInline(it)}</li>)}</ul>)
      continue
    }
    if (/^\s*\d+\.\s+/.test(line)) {
      const items: string[] = []
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i]!)) { items.push(lines[i]!.replace(/^\s*\d+\.\s+/, '')); i += 1 }
      nodes.push(<ol key={k++}>{items.map((it, idx) => <li key={idx}>{renderInline(it)}</li>)}</ol>)
      continue
    }
    if (line.includes('|') && i + 1 < lines.length && /^\s*\|?[\s:-]+\|/.test(lines[i + 1]!)) {
      const splitRow = (r: string) => r.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim())
      const head = splitRow(line)
      i += 2
      const body: string[][] = []
      while (i < lines.length && lines[i]!.includes('|') && lines[i]!.trim() !== '') { body.push(splitRow(lines[i]!)); i += 1 }
      nodes.push(<div className="md__tblwrap" key={k++}><table>
        <thead><tr>{head.map((c, idx) => <th key={idx}>{renderInline(c)}</th>)}</tr></thead>
        <tbody>{body.map((row, ri) => <tr key={ri}>{row.map((c, ci) => <td key={ci}>{renderInline(c)}</td>)}</tr>)}</tbody>
      </table></div>)
      continue
    }
    const para: string[] = [line]
    i += 1
    while (i < lines.length && lines[i]!.trim() !== '' && !/^(#{1,4}\s|```|\s*[-*]\s|\s*\d+\.\s|\s*>)/.test(lines[i]!)) {
      para.push(lines[i]!)
      i += 1
    }
    nodes.push(<p key={k++}>{para.map((l, idx) => <Fragment key={idx}>{idx > 0 && <br />}{renderInline(l)}</Fragment>)}</p>)
  }
  return <div className="md">{nodes}</div>
}
