/**
 * Admin 模块化路由处理器共享上下文契约。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AdminAuth } from '../auth.ts'
import type { AdminHost, AdminSettingsChange, SettingsSection } from '../host.ts'
import type { OptionsStore } from '../options.ts'
import type { EventLog } from '../../ledger/events.ts'
import type { Ledger } from '../../ledger/ledger.ts'
import type { ProjectService } from '../../projects/service.ts'
import type { CouncilService } from '../../council/service.ts'
import type { NovelService } from '../../novel/service.ts'
import type { ActivityLog } from '../../executor/activity.ts'
import type { FanqieService } from '../../fanqie/service.ts'
import type { PiVersionService } from '../../executor/pi-versions.ts'
import type { DevEnvService } from '../../executor/dev-env.ts'
import type { GoalService } from '../../goal/service.ts'
import type { ContractStore } from '../../contracts/store.ts'
import type { PentestService } from '../../pentest/service.ts'
import type { DirectorService } from '../../director/service.ts'
import type { PluginRegistry } from '../../plugins/registry.ts'

export interface AdminRouteDeps {
  host: AdminHost
  auth: AdminAuth
  store: OptionsStore
  ledger: Ledger
  events: EventLog
  projects?: ProjectService
  councils?: CouncilService
  activity?: Pick<ActivityLog, 'list'>
  novels?: NovelService
  fanqie?: FanqieService
  piVersions?: PiVersionService
  devEnv?: DevEnvService
  goals?: Pick<GoalService, 'view' | 'set' | 'cancel' | 'brief' | 'buildReceipt' | 'recordEvidence' | 'listEvidences'>
  contracts?: ContractStore
  pentest?: PentestService
  director?: DirectorService
  plugins?: PluginRegistry
  recordSettings: (section: SettingsSection, changed: string[], text: string) => void
  notify: (change: AdminSettingsChange) => void
  finishSettings: (res: ServerResponse, section: SettingsSection, changed: string[], extra?: Record<string, unknown>) => void
  noteFor: (section: SettingsSection, changed: string[], paused?: boolean) => string
  handleFiles: (res: ServerResponse, id: string, requested: string, raw?: boolean, download?: boolean) => void
}

export interface AdminRouteRequest {
  req: IncomingMessage
  res: ServerResponse
  url: URL
  method: string
  route: string
}

export type AdminRouteHandler = (deps: AdminRouteDeps, r: AdminRouteRequest) => Promise<boolean>
