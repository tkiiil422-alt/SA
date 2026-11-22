import { useCallback, useEffect, useRef, useState } from 'react'
import { get } from './api'
export const ago = (t?: string) => {
  if (!t) return ''
  const s = (Date.now() - Date.parse(t)) / 1000
  if (!Number.isFinite(s)) return ''
  return s < 60 ? '刚刚' : s < 3600 ? `${Math.floor(s / 60)} 分钟前` : s < 86400 ? `${Math.floor(s / 3600)} 小时前` : `${Math.floor(s / 86400)} 天前`
}
export const money = (n?: number) => (typeof n === 'number' ? `$${n.toFixed(n < 1 ? 4 : 2)}` : '—')
/** GET with periodic refresh, refresh on return to the page, no overlapping requests, and a manual reload. */
export function usePoll<T>(path: string | null, ms = 5000) {
  const [d, setD] = useState<T>()
  const [err, setErr] = useState('')
  const [status, setStatus] = useState(0)
  const busy = useRef(false)
  const alive = useRef(true)
  const run = useCallback(async () => {
    if (!path || busy.current) return
    busy.current = true
    try { const v = await get<T>(path); if (alive.current) { setD(v); setErr(''); setStatus(200) } }
    catch (e: any) { if (alive.current) { setErr(String(e.message)); setStatus(e.status || 0) } }
    finally { busy.current = false }
  }, [path])
  useEffect(() => {
    alive.current = true
    setD(undefined); setErr(''); setStatus(0)
    run()
    const t = setInterval(() => { if (!document.hidden) run() }, ms)
    const v = () => { if (!document.hidden) run() }
    document.addEventListener('visibilitychange', v)
    window.addEventListener('pageshow', v)
    return () => { alive.current = false; clearInterval(t); document.removeEventListener('visibilitychange', v); window.removeEventListener('pageshow', v) }
  }, [run, ms])
  return { d, err, status, reload: run }
}
