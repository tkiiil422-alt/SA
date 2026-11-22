/**
 * 子系统插件注册中心（PluginRegistry）。
 *
 * 负责统一管理所有子系统插件的注册、路由分发、Director/Worker 能力聚合、
 * 领域事件隔离派发与有序启停生命周期。
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { DomainEvent } from '../core/index.ts'
import type {
  DirectorHighRiskPluginAction,
  DirectorPluginContext,
  DirectorPromptInjectionContext,
  PluginDescriptor,
  PluginRouteContext,
  SubsystemPlugin,
  WorkerPluginContext,
  WorkerPromptInjectionContext,
} from './types.ts'

export interface PluginRegistryOptions {
  /** 插件钩子异常回调；默认输出到 stderr，绝不向上抛出拖垮核心流程。 */
  onError?: (pluginId: string, phase: string, error: unknown) => void
}

export class PluginRegistry {
  private readonly plugins: SubsystemPlugin[] = []
  private readonly byId = new Map<string, SubsystemPlugin>()
  private readonly onError: (pluginId: string, phase: string, error: unknown) => void
  private started = false

  constructor(options: PluginRegistryOptions = {}) {
    this.onError = options.onError ?? ((id, phase, error) => {
      console.error(`superagentd: plugin "${id}" ${phase} failed: ${error instanceof Error ? error.message : String(error)}`)
    })
  }

  /** 注册插件；重复 ID 会抛出明确错误，避免静默覆盖。 */
  register(plugin: SubsystemPlugin): this {
    if (this.byId.has(plugin.id)) {
      throw new Error(`插件 "${plugin.id}" 已注册，禁止重复注册`)
    }
    this.plugins.push(plugin)
    this.byId.set(plugin.id, plugin)
    return this
  }

  /** 按 ID 查找插件。 */
  get(id: string): SubsystemPlugin | undefined {
    return this.byId.get(id)
  }

  /** 检查某个插件当前是否处于启用状态。 */
  isEnabled(plugin: SubsystemPlugin): boolean {
    try {
      return plugin.enabled ? plugin.enabled() : true
    } catch (error) {
      this.onError(plugin.id, 'enabled()', error)
      return false
    }
  }

  /** 返回所有已注册插件的运行态摘要清单（供 `/api/plugins` 与 Director 自省使用）。 */
  list(): PluginDescriptor[] {
    return this.plugins.map(plugin => ({
      id: plugin.id,
      name: plugin.name,
      description: plugin.description,
      version: plugin.version,
      enabled: this.isEnabled(plugin),
      ...(plugin.routesPrefix ? { routesPrefix: plugin.routesPrefix } : {}),
      directorActions: [
        ...Object.keys(plugin.directorQueries ?? {}),
        ...Object.keys(plugin.directorActions ?? {}),
        ...Object.keys(plugin.directorHighRiskActions ?? {}),
      ],
      workerTools: plugin.registerWorkerMcpTools ? ['mcp'] : [],
    }))
  }

  /** 遍历已启用插件处理 HTTP `/api/*` 请求；命中即止。 */
  async handleRoute(ctx: PluginRouteContext): Promise<boolean> {
    for (const plugin of this.plugins) {
      if (!plugin.handleRoute || !this.isEnabled(plugin)) continue
      const handled = await plugin.handleRoute(ctx)
      if (handled) return true
    }
    return false
  }

  /** 查找并执行 Director 只读查询扩展动作；未命中返回 `{ matched: false }`。 */
  async dispatchDirectorQuery(
    action: string,
    args: Record<string, unknown>,
    ctx: DirectorPluginContext,
  ): Promise<{ matched: true; result: unknown } | { matched: false }> {
    for (const plugin of this.plugins) {
      if (!this.isEnabled(plugin)) continue
      const handler = plugin.directorQueries?.[action]
      if (handler) {
        return { matched: true, result: await handler(args, ctx) }
      }
    }
    return { matched: false }
  }

  /** 查找并执行 Director 普通子系统扩展动作；未命中返回 `{ matched: false }`。 */
  async dispatchDirectorAction(
    action: string,
    args: Record<string, unknown>,
    ctx: DirectorPluginContext,
  ): Promise<{ matched: true; result: unknown } | { matched: false }> {
    for (const plugin of this.plugins) {
      if (!this.isEnabled(plugin)) continue
      const handler = plugin.directorActions?.[action]
      if (handler) {
        return { matched: true, result: await handler(args, ctx) }
      }
    }
    return { matched: false }
  }

  /** 查找 Director 高危确认扩展动作。 */
  findDirectorHighRisk(action: string): { pluginId: string; handler: DirectorHighRiskPluginAction } | undefined {
    for (const plugin of this.plugins) {
      if (!this.isEnabled(plugin)) continue
      const handler = plugin.directorHighRiskActions?.[action]
      if (handler) return { pluginId: plugin.id, handler }
    }
    return undefined
  }

  /** 收集所有已启用插件向 Director 系统提示注入的片段。 */
  collectDirectorPromptSections(ctx: DirectorPromptInjectionContext): string[] {
    const sections: string[] = []
    for (const plugin of this.plugins) {
      if (!plugin.directorPromptSection || !this.isEnabled(plugin)) continue
      try {
        const text = plugin.directorPromptSection(ctx)?.trim()
        if (text) sections.push(text)
      } catch (error) {
        this.onError(plugin.id, 'directorPromptSection', error)
      }
    }
    return sections
  }

  /** 收集所有已启用插件向 Worker 启动上下文（AGENTS.md）注入的片段。 */
  collectWorkerPromptSections(ctx: WorkerPromptInjectionContext): string[] {
    const sections: string[] = []
    for (const plugin of this.plugins) {
      if (!plugin.workerPromptSection || !this.isEnabled(plugin)) continue
      try {
        const text = plugin.workerPromptSection(ctx)?.trim()
        if (text) sections.push(text)
      } catch (error) {
        this.onError(plugin.id, 'workerPromptSection', error)
      }
    }
    return sections
  }

  /** 向 Worker MCP Server 注册所有已启用插件的工具。 */
  registerWorkerMcpTools(server: McpServer, ctx: WorkerPluginContext): void {
    for (const plugin of this.plugins) {
      if (!plugin.registerWorkerMcpTools || !this.isEnabled(plugin)) continue
      try {
        plugin.registerWorkerMcpTools(server, ctx)
      } catch (error) {
        this.onError(plugin.id, 'registerWorkerMcpTools', error)
      }
    }
  }

  /** 将核心引擎领域事件安全广播给所有插件（单插件异常隔离）。 */
  emitDomainEvent(event: DomainEvent): void {
    for (const plugin of this.plugins) {
      if (!plugin.onDomainEvent || !this.isEnabled(plugin)) continue
      try {
        plugin.onDomainEvent(event)
      } catch (error) {
        this.onError(plugin.id, `onDomainEvent(${event.type})`, error)
      }
    }
  }

  /** 按注册顺序启动所有插件。 */
  async startAll(): Promise<void> {
    if (this.started) return
    this.started = true
    for (const plugin of this.plugins) {
      if (!plugin.start) continue
      try {
        await plugin.start()
      } catch (error) {
        this.onError(plugin.id, 'start', error)
      }
    }
  }

  /** 按注册逆序优雅停机所有插件。 */
  async stopAll(): Promise<void> {
    if (!this.started) return
    this.started = false
    for (let i = this.plugins.length - 1; i >= 0; i -= 1) {
      const plugin = this.plugins[i]!
      if (!plugin.stop) continue
      try {
        await plugin.stop()
      } catch (error) {
        this.onError(plugin.id, 'stop', error)
      }
    }
  }
}
