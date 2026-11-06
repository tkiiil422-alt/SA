/**
 * Shapes shared by the council store, the runner and the HTTP layer.
 *
 * The stored `data` block holds the planned roles, the requested round count and every round's turns; keeping it in one
 * JSON column means a partially finished council is always readable exactly as it was persisted.
 */
import type { CouncilRoleModel } from './roles.ts'

export type CouncilMode = 'brief' | 'decision'
export type CouncilStatus = 'running' | 'done' | 'failed' | 'cancelled'
/** `queued` while waiting for a slot; then `round-1` … `round-N`; `summary` while the moderator speaks; `done` after. */
export type CouncilPhase = 'queued' | `round-${number}` | 'summary' | 'done'
export type CouncilTurnStatus = 'pending' | 'running' | 'done' | 'failed'

export interface CouncilTurn {
  roleId: string
  name: string
  status: CouncilTurnStatus
  text: string
  /** Wall time of the upstream call in milliseconds. */
  ms: number
  costUsd: number
}

export interface CouncilRound {
  n: number
  turns: CouncilTurn[]
}

/** A role as resolved for one council: the settings of the moment, with a concrete model. */
export interface CouncilSeat {
  id: string
  name: string
  persona: string
  model: CouncilRoleModel
}

export interface CouncilData {
  roundsPlanned: number
  seats: CouncilSeat[]
  rounds: CouncilRound[]
  moderator: CouncilRoleModel
  /** Brief mode only: open the ticket as soon as the task book is ready, instead of waiting for 直接开工. */
  autoStart?: boolean
}

export interface CouncilRecord {
  id: string
  mode: CouncilMode
  status: CouncilStatus
  phase: CouncilPhase
  topic: string
  projectId?: string
  ticketId?: string
  data: CouncilData
  brief?: string
  costUsd: number
  error?: string
  createdAt: string
  updatedAt: string
}

/** One ledger entry for a council call; `cost` is what the runtime's price table says it cost. */
export interface CouncilUsage {
  provider: string
  model: string
  usage?: {
    prompt_tokens: number
    completion_tokens: number
    prompt_cache_hit_tokens: number
    prompt_cache_miss_tokens: number
  }
  latencyMs: number
  status: number
  ok: boolean
}
