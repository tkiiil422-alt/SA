/**
 * 控制台 HTTP 服务装配与内置子系统插件描述符注册。
 *
 * 从 `src/runtime.ts` 拆出，降低组合根复杂度，统一承载：
 * - React 控制台静态托管（兼容 `/legacy`、`/next` 旧书签跳转）
 * - Preview 预览代理
 * - 飞书 / 微信入站 Webhook 回调分发
 * - 内置核心子系统（小说、番茄、安全工作台）在 `PluginRegistry` 中的只读描述符注册
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createAdminServer, type AdminServer } from '../admin/server.ts'
import { createStaticHandler } from '../admin/static.ts'
import { createPreviewProxy, type PreviewStore } from '../admin/preview.ts'
import type { AdminApi } from '../admin/api.ts'
import type { OptionsStore } from '../admin/options.ts'
import type { FeishuSource } from '../sources/feishu.ts'
import type { WechatSource } from '../sources/wechat.ts'
import type { PluginRegistry } from '../plugins/registry.ts'

export interface CreateConsoleServerOptions {
  api: AdminApi
  previews: PreviewStore
  optionsStore: OptionsStore
  workspaceRoot: string
  feishu: FeishuSource
  wechat: WechatSource
  port: number
  host?: string
}

/** 创建并装配控制台 HTTP 服务器（API + React 静态资源 + Preview + 通道回调）。 */
export function createConsoleServer(opts: CreateConsoleServerOptions): AdminServer {
  const { api, previews, optionsStore, workspaceRoot, feishu, wechat, port, host = '127.0.0.1' } = opts
  const consoleRoot = join(dirname(fileURLToPath(import.meta.url)), '..', 'admin', 'web-next')
  const previewProxy = createPreviewProxy({
    store: previews,
    publicBase: () => optionsStore.get().preview.publicBase,
    staticRoot: ticketId => join(workspaceRoot, ticketId, 'output'),
  })

  const consoleHandler = createStaticHandler(consoleRoot)
  const mounted = (prefix: string, req: IncomingMessage, res: ServerResponse): boolean => {
    const original = req.url
    req.url = (req.url ?? '/').slice(prefix.length) || '/'
    try { return consoleHandler(req, res) } finally { req.url = original }
  }

  return createAdminServer({
    api,
    staticHandler: (req, res) => {
      const path = (req.url ?? '/').split('?')[0] ?? '/'
      // 统一使用新版 React 控制台；旧 /legacy 与 /next 入口做 302 跳转兼容历史书签。
      if (path === '/legacy' || path === '/next') { res.writeHead(302, { location: './' }); res.end(); return true }
      if (path === '/legacy/' || path === '/next/') { res.writeHead(302, { location: '../' }); res.end(); return true }
      if (path.startsWith('/next/')) return mounted('/next', req, res)
      return consoleHandler(req, res)
    },
    callbacks: async (req, res) => {
      const mount = /^\/next(\/api(?:\/|$|\?))/.exec(req.url ?? '')
      if (mount) req.url = (req.url ?? '').slice(5)
      if (await previewProxy(req, res)) return true
      const url = new URL(req.url ?? '/', 'http://admin.invalid')
      if (url.pathname === '/feishu/events') {
        await feishu.handleHttp(req, res)
        return true
      }
      if (url.pathname === '/wechat/events') {
        await wechat.handleHttp(req, res)
        return true
      }
      return false
    },
    host,
    port,
  })
}

/** 将内置核心垂直子系统登记到 `PluginRegistry`，使 `/api/plugins` 与 Director 可统一自省。 */
export function registerBuiltinDescriptors(plugins: PluginRegistry, optionsStore: OptionsStore): void {
  plugins.register({
    id: 'novel',
    name: '长篇小说引擎',
    description: '多角色设定集维护、分卷大纲、连载写作、连贯性校验与章节修订',
    version: '1.0.0',
    routesPrefix: '/novels',
    enabled: () => optionsStore.get().novel.enabled,
  })
  plugins.register({
    id: 'fanqie',
    name: '番茄小说同步',
    description: '番茄作家平台章节绑定、草稿/定时/发布同步与状态检查',
    version: '1.0.0',
    routesPrefix: '/fanqie',
    enabled: () => optionsStore.get().novel.enabled,
  })
  plugins.register({
    id: 'pentest',
    name: '防御与安全工作台',
    description: '授权内网应用安全代码审查、配置基线核查、OWASP 剧本与漏洞管理',
    version: '1.0.0',
    routesPrefix: '/pentest',
    enabled: () => true,
  })
}
