/**
 * Multi-model collaboration inside one ticket.
 *
 * The ticket's main worker (Pi) can hand a piece of work to another model through the `subagent` tool of
 * `deploy/pi-ext/collab.ts`. Each launch, the runtime copies that extension into the ticket's Pi config directory
 * (where Pi discovers it) and writes the role table as `collab.json`; a ticket created with collaboration switched off
 * gets neither. This module holds the default roles, builds `collab.json`, and remembers per-ticket opt-outs.
 */
import type { DatabaseSync, StatementSync } from 'node:sqlite'
import type { ModelRef } from '../admin/options.ts'
import { piProviderId } from './pi-models.ts'

/** What a sub-agent may do: answer only, read files, read and run commands, or change files. */
export type CollabAccess = 'ask' | 'read' | 'shell' | 'write'

export interface CollabRoleDefaults {
  id: string
  name: string
  description: string
  access: CollabAccess
  enabled: boolean
  /** Null means the ticket's own model. */
  model: ModelRef | null
  prompt: string
}

/** The five default seats. Models are left to the ticket's model; the console points them at cheaper or stronger ones. */
export function defaultCollabRoles(): CollabRoleDefaults[] {
  return [
    {
      id: 'scout', name: '侦察', access: 'read', enabled: true, model: null,
      description: '大范围找代码、配置和资料，交回压缩后的结论（路径、行号、要点）。适合先摸清情况。',
      prompt: '你负责侦察：在工作区里找到和任务相关的文件、函数、配置和文档，交回压缩后的结论。列出具体路径和行号，只摘关键几行，不要整段贴代码。',
    },
    {
      id: 'planner', name: '规划', access: 'read', enabled: true, model: null,
      description: '读代码后给出实现方案：改哪些文件、按什么顺序、怎么验证、有哪些风险。不动文件。',
      prompt: '你负责规划：读相关代码后给出 1–2 个可行方案，写清要改的文件、步骤顺序、验证方法和风险；引用真实存在的路径，不编造文件或命令。',
    },
    {
      id: 'reviewer', name: '审查', access: 'shell', enabled: true, model: null,
      description: '交付前审改动：找 bug、遗漏和不一致，可以运行只读命令（git diff、测试）。',
      prompt: '你负责审查：先看改动（git diff、git status），再读相关代码、必要时运行测试。按严重程度列出问题，每条写明文件、行号、原因和建议的改法；没发现问题就明确说没发现。',
    },
    {
      id: 'advisor', name: '顾问', access: 'ask', enabled: true, model: null,
      description: '只回答问题，不看文件。适合难题、方案取舍、第二意见；需要的代码片段要放进任务说明里。',
      prompt: '你是顾问：只依据任务说明里给出的内容回答，给出明确结论和理由；信息不够时说清还缺什么。',
    },
    {
      id: 'helper', name: '帮手', access: 'write', enabled: true, model: null,
      description: '做边界清楚的机械改动：批量改名、补测试、改格式。可以改文件，一次只跑一个。',
      prompt: '你是帮手：只改任务里点名的文件和范围，不做额外重构。做完列出改了哪些文件、每处改了什么、跑了什么验证以及结果。',
    },
  ]
}

export interface CollabSettings {
  enabled: boolean
  maxConcurrent: number
  maxCalls: number
  roles: CollabRoleDefaults[]
}

/** One role as the extension sees it: the model is already a Pi model string (`sa-<provider>/<model>`). */
export interface CollabFileRole {
  id: string
  name: string
  description: string
  access: CollabAccess
  model: string
  prompt: string
}

/** `<pi-config>/collab.json`, read by the extension on load and on every call. */
export interface CollabFile {
  version: 1
  mainModel: string
  maxConcurrent: number
  maxCalls: number
  /** Names (never values) of the secrets granted to this ticket; read-only roles get none of them. */
  secretNames: string[]
  roles: CollabFileRole[]
}

export const piModelString = (ref: ModelRef): string => `${piProviderId(ref.provider)}/${ref.model}`

/**
 * The role table for one launch. A role without a model, or whose model is no longer usable, runs on the ticket's own
 * model, so a disabled provider never breaks delegation.
 */
export function collabFile(
  settings: CollabSettings,
  usable: (ref: ModelRef) => boolean,
  main: ModelRef,
  secretNames: readonly string[],
): CollabFile {
  const mainModel = piModelString(main)
  return {
    version: 1,
    mainModel,
    maxConcurrent: settings.maxConcurrent,
    maxCalls: settings.maxCalls,
    secretNames: [...new Set(secretNames)].sort(),
    roles: settings.roles.filter(role => role.enabled).map(role => ({
      id: role.id,
      name: role.name,
      description: role.description,
      access: role.access,
      model: role.model !== null && usable(role.model) ? piModelString(role.model) : mainModel,
      prompt: role.prompt,
    })),
  }
}

const AGENT_ID = /^[a-z0-9][a-z0-9-]{0,31}$/

/**
 * A sub-agent's token is the ticket token plus `.<role>`; ticket tokens are base64url, so they never contain a dot.
 * Returns the ticket token and the role ('' for the main worker), or undefined when the suffix is not a role id.
 */
export function splitAgentToken(token: string): { token: string; agent: string } | undefined {
  const dot = token.indexOf('.')
  if (dot < 0) return { token, agent: '' }
  const agent = token.slice(dot + 1)
  return AGENT_ID.test(agent) ? { token: token.slice(0, dot), agent } : undefined
}

/** Tickets created with collaboration switched off, keyed by the origin trigger id (known before the ticket id). */
export class CollabChoices {
  private readonly insert: StatementSync
  private readonly select: StatementSync

  constructor(db: DatabaseSync, private readonly now: () => Date = () => new Date()) {
    db.exec('CREATE TABLE IF NOT EXISTS collab_off (trigger_id TEXT PRIMARY KEY, at TEXT NOT NULL)')
    this.insert = db.prepare('INSERT OR REPLACE INTO collab_off (trigger_id, at) VALUES (?, ?)')
    this.select = db.prepare('SELECT 1 AS off FROM collab_off WHERE trigger_id = ?')
  }

  setOff(triggerId: string): void {
    this.insert.run(triggerId, this.now().toISOString())
  }

  isOff(triggerId: string): boolean {
    return this.select.get(triggerId) !== undefined
  }
}
