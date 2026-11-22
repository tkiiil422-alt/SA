/**
 * The Feishu long connection: events arrive over the official SDK's WebSocket instead of an HTTP callback.
 *
 * An app whose event subscription is set to "long connection" delivers nothing to `/feishu/events`, so this transport
 * is an alternative to `FeishuSource`'s callback, not an addition. The message→Trigger rules are the same ones the
 * callback uses (`triggerFromMessageEvent`); only the transport differs. Secrets never appear in status, events or
 * errors: `lastError` and every emitted text are scrubbed of the configured credentials.
 */
import { EventDispatcher, LoggerLevel, WSClient } from '@larksuiteoapi/node-sdk'
import type { Trigger } from '../core/model.ts'
import { triggerFromMessageEvent, type MessageEventLike } from './feishu.ts'

export { triggerFromMessageEvent }
export type { MessageEventLike }

/** The fields of the feishu options this transport needs; read on every start so a console change applies at once. */
export interface FeishuWsConfig {
  appId: string
  appSecret: string
  verificationToken: string
  encryptKey: string
  groupMode: 'mention' | 'all'
}

export interface FeishuWsStatus {
  state: 'off' | 'connecting' | 'connected' | 'error'
  /** When the current state began. */
  since?: string
  /** When the last event payload arrived over the connection (even one that produced no Trigger). */
  lastEventAt?: string
  /** The last failure, scrubbed of every configured secret. */
  lastError?: string
}

export interface FeishuWsEvent {
  kind: 'feishu.ws'
  level: 'info' | 'warn'
  text: string
  data?: Record<string, unknown>
}

/** The constructor parameters handed to the SDK's `WSClient`, plus the lifecycle callbacks used for status. */
export interface WsClientParams {
  appId: string
  appSecret: string
  loggerLevel: LoggerLevel
  onReady?: () => void
  onError?: (error: Error) => void
  onReconnecting?: () => void
  onReconnected?: () => void
}

/** The slice of `WSClient` this transport uses; injectable so tests never open a socket. */
export interface WsClientLike {
  start(params: { eventDispatcher: EventDispatcher }): Promise<void>
  close(params?: { force?: boolean }): void
}

export interface FeishuWsOptions {
  config: () => FeishuWsConfig
  /** Receives each accepted message, exactly like the HTTP callback's `onTrigger`. */
  onTrigger: (trigger: Trigger) => void
  /** Connection state and failures; text and data never carry secrets. */
  onEvent?: (event: FeishuWsEvent) => void
  onError?: (error: Error) => void
  /** The bot's own open_id for group mention matching; looked up once per connection and cached. */
  botOpenId?: () => Promise<string | undefined>
  /** Defaults to `new WSClient(params)`; tests inject a fake so no socket is opened. */
  clientFactory?: (params: WsClientParams) => WsClientLike
}

const LOGGER_LEVEL = LoggerLevel.warn

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Replace every configured secret in a message, so an SDK error can be surfaced without leaking credentials. */
function scrub(text: string, cfg: FeishuWsConfig): string {
  let value = text
  for (const secret of [cfg.appSecret, cfg.verificationToken, cfg.encryptKey]) {
    if (secret !== '') value = value.split(secret).join('***')
  }
  return value
}

export class FeishuWs {
  private readonly deps: FeishuWsOptions
  private client?: WsClientLike
  private dispatcher?: EventDispatcher
  private state: FeishuWsStatus = { state: 'off' }
  private bot?: Promise<string | undefined>
  private starting?: Promise<void>
  /** Bumped on every stop, so a start that loses the race closes the client it built instead of resurrecting it. */
  private generation = 0

  constructor(deps: FeishuWsOptions) {
    this.deps = deps
  }

  status(): FeishuWsStatus {
    return { ...this.state }
  }

  /** Build the dispatcher and client and open the connection. Never rejects; failures land in `status()`. */
  start(): Promise<void> {
    if (this.client) return Promise.resolve()
    if (this.starting) return this.starting
    const flight = this.doStart().catch(error => {
      this.fail(error, this.deps.config())
    })
    this.starting = flight
    // Clear only this flight: a stop may have cleared the slot and a newer start may own it now.
    void flight.then(() => {
      if (this.starting === flight) this.starting = undefined
    })
    return flight
  }

  /** Close the connection. Safe to call when it never started. */
  stop(): void {
    this.generation += 1
    this.starting = undefined
    const client = this.client
    this.client = undefined
    this.dispatcher = undefined
    this.bot = undefined
    if (client) {
      try {
        client.close()
      } catch {
        // A client that already gave up has nothing left to close.
      }
    }
    const next: FeishuWsStatus = { state: 'off' }
    if (this.state.lastEventAt !== undefined) next.lastEventAt = this.state.lastEventAt
    if (this.state.lastError !== undefined) next.lastError = this.state.lastError
    this.state = next
  }

  async restart(): Promise<void> {
    this.stop()
    await this.start()
  }

  private async doStart(): Promise<void> {
    const generation = this.generation
    const cfg = this.deps.config()
    if (cfg.appId === '' || cfg.appSecret === '') {
      this.fail(new Error('缺少 App ID 或 App Secret'), cfg)
      return
    }

    this.transition('connecting')
    this.bot = undefined

    // The WS dispatcher is invoked with `needCheck: false` by the SDK (the socket itself is authenticated), but the
    // credentials are still registered so a dispatcher shared with a webhook path would verify the same way.
    const dispatcher = new EventDispatcher({
      verificationToken: cfg.verificationToken,
      encryptKey: cfg.encryptKey,
      loggerLevel: LOGGER_LEVEL,
    })
    dispatcher.register({
      'im.message.receive_v1': (data: MessageEventLike) => this.handleEvent(data),
    })

    const factory = this.deps.clientFactory ?? ((params: WsClientParams) => new WSClient(params))
    let client: WsClientLike
    try {
      client = factory({
        appId: cfg.appId,
        appSecret: cfg.appSecret,
        loggerLevel: LOGGER_LEVEL,
        onReady: () => {
          if (generation !== this.generation) return
          this.transition('connected')
          this.emit('info', '飞书长连接已连接')
        },
        onReconnecting: () => {
          if (generation !== this.generation) return
          this.transition('connecting')
          this.emit('info', '飞书长连接断开，正在重连')
        },
        onReconnected: () => {
          if (generation !== this.generation) return
          this.transition('connected')
          this.emit('info', '飞书长连接已重新连接')
        },
        onError: error => {
          if (generation !== this.generation) return
          this.fail(error, cfg)
        },
      })
    } catch (error) {
      this.fail(error, cfg)
      return
    }

    if (generation !== this.generation) {
      // `stop()` ran while the client was being built: close it rather than leave a live socket behind.
      try {
        client.close()
      } catch {
        // Never started, so there is nothing to close.
      }
      return
    }

    this.client = client
    this.dispatcher = dispatcher
    try {
      await client.start({ eventDispatcher: dispatcher })
    } catch (error) {
      this.client = undefined
      this.dispatcher = undefined
      try {
        client.close()
      } catch {
        // Already closed by the SDK after a failed start.
      }
      if (generation === this.generation) this.fail(error, cfg)
    }
  }

  /** Convert one pushed event with the shared rules and hand the Trigger on. */
  private async handleEvent(data: MessageEventLike): Promise<void> {
    const cfg = this.deps.config()
    this.state = { ...this.state, lastEventAt: new Date().toISOString() }
    try {
      const botOpenId = await this.botOpenId()
      const result = triggerFromMessageEvent(data, {
        ...(botOpenId ? { botOpenId } : {}),
        groupMode: cfg.groupMode,
      })
      if ('ignored' in result) return
      this.deps.onTrigger(result)
    } catch (error) {
      this.fail(error, cfg)
    }
  }

  private botOpenId(): Promise<string | undefined> {
    this.bot ??= Promise.resolve()
      .then(() => this.deps.botOpenId?.())
      .then(value => value ?? undefined)
      .catch(() => undefined)
    return this.bot
  }

  private transition(state: 'connecting' | 'connected'): void {
    const next: FeishuWsStatus = { state, since: new Date().toISOString() }
    if (state !== 'connected' && this.state.lastError !== undefined) next.lastError = this.state.lastError
    if (this.state.lastEventAt !== undefined) next.lastEventAt = this.state.lastEventAt
    this.state = next
  }

  private fail(error: unknown, cfg: FeishuWsConfig): void {
    const message = scrub(describe(error), cfg)
    const next: FeishuWsStatus = { state: 'error', since: new Date().toISOString(), lastError: message }
    if (this.state.lastEventAt !== undefined) next.lastEventAt = this.state.lastEventAt
    this.state = next
    this.emit('warn', `飞书长连接出错：${message}`)
    try {
      this.deps.onError?.(new Error(message))
    } catch {
      // Reporting a failure must not break the transport.
    }
  }

  private emit(level: 'info' | 'warn', text: string, data?: Record<string, unknown>): void {
    try {
      this.deps.onEvent?.({ kind: 'feishu.ws', level, text, ...(data === undefined ? {} : { data }) })
    } catch {
      // Logging must never break the connection.
    }
  }
}
