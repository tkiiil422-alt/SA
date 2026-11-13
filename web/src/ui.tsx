import { useEffect, useState, type ReactNode } from 'react'

/** Shared bits: toast, busy-guarded actions, sheets, empty states. */
let pushToast: (text: string, bad?: boolean) => void = () => {}
export const toast = (text: string, bad = false) => pushToast(text, bad)
export function ToastHost() {
  const [t, setT] = useState<{ text: string; bad: boolean; n: number } | null>(null)
  useEffect(() => { pushToast = (text, bad = false) => setT({ text, bad, n: Date.now() }) }, [])
  useEffect(() => { if (!t) return; const x = setTimeout(() => setT(null), 2600); return () => clearTimeout(x) }, [t])
  return t ? <p className={t.bad ? 'toast bad' : 'toast'} role="status">{t.text}</p> : null
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
      <div className="sheet__head"><b>{title}</b><button className="ghost" onClick={onClose} aria-label="关闭">✕</button></div>
      {children}
    </div>
  </div>
}

export function Empty({ children }: { children: ReactNode }) { return <p className="empty">{children}</p> }

export function Tabs({ value, onChange, items }: { value: string; onChange: (v: string) => void; items: [string, string][] }) {
  return <div className="seg" role="tablist">{items.map(([k, n]) => <button key={k} role="tab" aria-pressed={value === k} aria-selected={value === k} onClick={() => onChange(k)}>{n}</button>)}</div>
}

export const bytes = (n?: number) => typeof n !== 'number' ? '' : n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : n < 1073741824 ? `${(n / 1048576).toFixed(1)} MB` : `${(n / 1073741824).toFixed(2)} GB`
