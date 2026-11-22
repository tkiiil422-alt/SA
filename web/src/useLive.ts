import { createContext, useContext, useEffect, useState } from 'react'
import { API, get } from './api'

export interface RunningStep {
  id: string; summary: string; kind: string; at: string; tool?: string; status?: string; since?: string
  model?: string
  agents?: { role: string; name?: string; model?: string; state: string }[]
}
export interface Board {
  now: string
  paused: boolean
  slots: { used: number; max: number; reservedForPerson?: number }
  tickets: { open: number; running: number; needsPerson: number; endedToday: number }
  usage: { todayUsd: number; todayCalls?: number; dailyBudgetUsd?: number }
  upstream?: { ok: boolean; model?: string; provider?: string }
  runningSteps: RunningStep[]
  open: any[]
  ended: any[]
  alerts: { level: string; text: string; link?: string }[]
}
export interface Live { board?: Board; live: boolean; err: string; skew: number }

/**
 * One connection for the whole console: SSE on api/live/stream, which only sends when the board changed.
 * While the stream is down it rebuilds the same board from the plain endpoints every 5 s.
 */
export function useLiveSource(enabled: boolean): Live {
  const [state, setState] = useState<Live>({ live: false, err: '', skew: 0 })
  useEffect(() => {
    if (!enabled) return
    let es: EventSource | undefined
    let timer: number | undefined
    let retry: number | undefined
    let dead = false
    const take = (b: Board, live: boolean) => setState({ board: b, live, err: '', skew: Date.parse(b.now) - Date.now() || 0 })
    const poll = async () => {
      timer = undefined
      if (dead || es?.readyState === 1) return
      try {
        const [o, open, ended] = await Promise.all([get('api/overview'), get('api/tickets?status=open&limit=60'), get('api/tickets?status=ended&limit=8')])
        if (!dead && es?.readyState !== 1) take({ ...o, open: open.items || [], ended: ended.items || [], runningSteps: o.runningSteps || [], usage: o.usage || {} }, false)
      } catch (e: any) { if (!dead) setState(s => ({ ...s, live: false, err: String(e?.message || e) })) }
      if (!dead) timer = window.setTimeout(poll, 5000)
    }
    const open = () => {
      if (dead) return
      if (typeof EventSource === 'undefined') { poll(); return }
      es = new EventSource(API('api/live/stream'))
      es.addEventListener('board', e => take(JSON.parse((e as MessageEvent).data), true))
      es.onerror = () => {
        es?.close(); es = undefined
        setState(s => ({ ...s, live: false }))
        if (!dead && !timer) poll()
        if (!dead && !retry) retry = window.setTimeout(() => { retry = undefined; open() }, 8000)
      }
    }
    open()
    const vis = () => { if (!document.hidden && !es && !dead) { if (retry) { clearTimeout(retry); retry = undefined } open() } }
    document.addEventListener('visibilitychange', vis)
    window.addEventListener('online', vis)
    return () => {
      dead = true; es?.close()
      if (timer) clearTimeout(timer)
      if (retry) clearTimeout(retry)
      document.removeEventListener('visibilitychange', vis)
      window.removeEventListener('online', vis)
    }
  }, [enabled])
  return state
}

export const LiveContext = createContext<Live>({ live: false, err: '', skew: 0 })
export const useLive = () => useContext(LiveContext)

/** Re-renders every second so elapsed clocks tick between board updates. */
export function useTick(ms = 1000) {
  const [, set] = useState(0)
  useEffect(() => { const t = setInterval(() => { if (!document.hidden) set(n => n + 1) }, ms); return () => clearInterval(t) }, [ms])
}

/** 4:07 / 1:02:33 — elapsed time since an ISO timestamp, corrected for server clock skew. */
export function clock(since?: string, skew = 0) {
  if (!since) return ''
  const s = Math.max(0, Math.floor((Date.now() + skew - Date.parse(since)) / 1000))
  if (!Number.isFinite(s)) return ''
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60
  const p = (n: number) => String(n).padStart(2, '0')
  return h ? `${h}:${p(m)}:${p(sec)}` : `${m}:${p(sec)}`
}
export const secondsSince = (at?: string, skew = 0) => at ? Math.max(0, (Date.now() + skew - Date.parse(at)) / 1000) : 0
