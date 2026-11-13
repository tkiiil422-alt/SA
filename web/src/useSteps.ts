import { useEffect, useRef, useState } from 'react'
import { API, get } from './api'
export interface Step {
  id: number; seq: number; at: string; kind: string; tool?: string; summary: string; detail?: string; status: string; ms?: number
  /** Model that made the step (the main worker). */
  model?: string
  /** A delegation's sub-agents, each with its model and state. */
  agents?: { role: string; name?: string; model?: string; state: string }[]
}
/** Steps for a ticket: SSE with Last-Event-ID resume; falls back to 3s polling while the stream is down. */
export function useSteps(id: string) {
  const [steps, setSteps] = useState<Step[]>([])
  const [live, setLive] = useState(false)
  const last = useRef(0)
  useEffect(() => {
    let es: EventSource | undefined
    let timer: number | undefined
    let dead = false
    let streaming = false
    setSteps([]); last.current = 0
    const merge = (items: Step[]) => setSteps(prev => {
      const m = new Map(prev.map(s => [s.id, s])); items.forEach(s => m.set(s.id, s))
      return [...m.values()].sort((a, b) => a.seq - b.seq).slice(-500)
    })
    const pull = async () => {
      try {
        const d = await get(`api/tickets/${id}/activity?${last.current ? `after=${last.current}` : 'limit=200'}`)
        if ((d.last || 0) < last.current) { last.current = 0; setSteps([]) }
        last.current = Math.max(last.current, d.last || 0)
        if (d.items?.length) merge(d.items)
      } catch { /* next round */ }
    }
    const poll = async () => {
      timer = undefined
      if (dead || streaming) return
      await pull()
      if (!dead && !streaming) timer = window.setTimeout(poll, 3000)
    }
    const open = () => {
      if (dead || typeof EventSource === 'undefined') { poll(); return }
      es = new EventSource(API(`api/tickets/${id}/activity/stream?after=${last.current}`))
      es.onopen = () => { streaming = true; setLive(true); if (timer) { clearTimeout(timer); timer = undefined } }
      es.addEventListener('step', e => {
        const s = JSON.parse((e as MessageEvent).data) as Step
        last.current = Math.max(last.current, s.seq); merge([s])
      })
      es.onerror = () => {
        streaming = false; setLive(false); es?.close(); es = undefined
        if (!dead) { if (!timer) poll(); window.setTimeout(() => { if (!dead && !es) open() }, 10000) }
      }
    }
    pull().finally(() => { if (!dead) open() })
    const vis = () => {
      if (document.hidden) return
      pull()
      if (!es && !dead) open()
    }
    document.addEventListener('visibilitychange', vis)
    window.addEventListener('pageshow', vis)
    window.addEventListener('online', vis)
    return () => {
      dead = true; es?.close(); if (timer) clearTimeout(timer)
      document.removeEventListener('visibilitychange', vis)
      window.removeEventListener('pageshow', vis)
      window.removeEventListener('online', vis)
    }
  }, [id])
  return { steps, live }
}
