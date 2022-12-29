import cluster from 'cluster'
import { EventEmitter } from 'stream'
import { IncomingMessage as IncomingHttpMessage } from 'http'
import { WebSocket } from 'ws'

import { createNoticeMessage, createOutgoingEventMessage } from '../utils/messages'
import { IAbortable, IMessageHandler } from '../@types/message-handlers'
import { IncomingMessage, OutgoingMessage } from '../@types/messages'
import { IWebSocketAdapter, IWebSocketServerAdapter } from '../@types/adapters'
import { SubscriptionFilter, SubscriptionId } from '../@types/subscription'
import { WebSocketAdapterEvent, WebSocketServerAdapterEvent } from '../constants/adapter'
import { attemptValidation } from '../utils/validation'
import { createLogger } from '../factories/logger-factory'
import { Event } from '../@types/event'
import { Factory } from '../@types/base'
import { IRateLimiter } from '../@types/utils'
import { ISettings } from '../@types/settings'
import { isEventMatchingFilter } from '../utils/event'
import { messageSchema } from '../schemas/message-schema'

const debug = createLogger('web-socket-adapter')
const debugHeartbeat = debug.extend('heartbeat')

const abortableMessageHandlers: WeakMap<WebSocket, IAbortable[]> = new WeakMap()

export class WebSocketAdapter extends EventEmitter implements IWebSocketAdapter {
  public clientId: string
  private clientAddress: string
  private alive: boolean
  private subscriptions: Map<SubscriptionId, SubscriptionFilter[]>

  public constructor(
    private readonly client: WebSocket,
    private readonly request: IncomingHttpMessage,
    private readonly webSocketServer: IWebSocketServerAdapter,
    private readonly createMessageHandler: Factory<IMessageHandler, [IncomingMessage, IWebSocketAdapter]>,
    private readonly slidingWindowRateLimiter: Factory<IRateLimiter>,
    private readonly settings: Factory<ISettings>,
  ) {
    super()
    this.alive = true
    this.subscriptions = new Map()

    this.clientId = Buffer.from(this.request.headers['sec-websocket-key'], 'base64').toString('hex')
    const remoteIpHeader = this.settings().network?.remote_ip_header ?? 'x-forwarded-for'
    this.clientAddress = (this.request.headers[remoteIpHeader] ?? this.request.socket.remoteAddress) as string

    this.client
      .on('message', this.onClientMessage.bind(this))
      .on('close', this.onClientClose.bind(this))
      .on('pong', this.onClientPong.bind(this))
      .on('error', (error) => {
        if (error.name === 'RangeError' && error.message === 'Max payload size exceeded') {
          debug('client %s from %s sent payload too large', this.clientId, this.clientAddress)
        } else {
          debug('error', error)
        }
      })

    this
      .on(WebSocketAdapterEvent.Heartbeat, this.onHeartbeat.bind(this))
      .on(WebSocketAdapterEvent.Subscribe, this.onSubscribed.bind(this))
      .on(WebSocketAdapterEvent.Unsubscribe, this.onUnsubscribed.bind(this))
      .on(WebSocketAdapterEvent.Event, this.onSendEvent.bind(this))
      .on(WebSocketAdapterEvent.Broadcast, this.onBroadcast.bind(this))
      .on(WebSocketAdapterEvent.Message, this.sendMessage.bind(this))

    debug('client %s connected from %s', this.clientId, this.clientAddress)
  }

  public getClientId(): string {
    return this.clientId
  }

  public getClientAddress(): string {
    return this.clientAddress
  }

  public onUnsubscribed(subscriptionId: string): void {
    debug('client %s unsubscribed %s', this.clientId, subscriptionId)
    this.subscriptions.delete(subscriptionId)
  }

  public onSubscribed(subscriptionId: string, filters: SubscriptionFilter[]): void {
    debug('client %s subscribed %s to %o', this.clientId, subscriptionId, filters)
    this.subscriptions.set(subscriptionId, filters)
  }

  public onBroadcast(event: Event): void {
    this.webSocketServer.emit(WebSocketServerAdapterEvent.Broadcast, event)
    if (cluster.isWorker) {
      process.send({
        eventName: WebSocketServerAdapterEvent.Broadcast,
        event,
      })
    }
  }

  public onSendEvent(event: Event): void {
    this.subscriptions.forEach((filters, subscriptionId) => {
      if (
        filters.map(isEventMatchingFilter).some((Matches) => Matches(event))
      ) {
        this.sendMessage(createOutgoingEventMessage(subscriptionId, event))
      }
    })
  }

  private sendMessage(message: OutgoingMessage): void {
    this.client.send(JSON.stringify(message))
  }

  public onHeartbeat(): void {
    if (!this.alive) {
      debug('client %s pong timed out', this.clientId)
      this.terminate()
      return
    }

    this.alive = false
    this.client.ping()
    debugHeartbeat('client %s ping', this.clientId)
  }

  public getSubscriptions(): Map<string, SubscriptionFilter[]> {
    return new Map(this.subscriptions)
  }

  private terminate(): void {
    debug('terminating client %s', this.clientId)
    this.client.terminate()
    debug('client %s terminated', this.clientId)
  }

  private async onClientMessage(raw: Buffer) {
    let abortable = false
    let messageHandler: IMessageHandler & IAbortable
    try {
      if (await this.isRateLimited(this.clientAddress)) {
        this.sendMessage(createNoticeMessage('rate limited'))
        return
      }

      const message = attemptValidation(messageSchema)(JSON.parse(raw.toString('utf8')))

      messageHandler = this.createMessageHandler([message, this]) as IMessageHandler & IAbortable
      abortable = typeof messageHandler?.abort === 'function'

      if (abortable) {
        const handlers = abortableMessageHandlers.get(this.client) ?? []
        handlers.push(messageHandler)
        abortableMessageHandlers.set(this.client, handlers)
      }

      await messageHandler?.handleMessage(message)
    } catch (error) {
      if (error instanceof Error) {
        if (error.name === 'AbortError') {
          debug('message handler aborted')
        } else if (error.name === 'SyntaxError' || error.name === 'ValidationError') {
          if (typeof (error as any).annotate === 'function') {
            debug('invalid message: %o', (error as any).annotate())
          } else {
            debug('malformed message: %s', error.message)
          }
          this.sendMessage(createNoticeMessage(`invalid: ${error.message}`))
        }
      } else {
        console.error('unable to handle message', error)
      }
    } finally {
      if (abortable) {
        const handlers = abortableMessageHandlers.get(this.client)
        const index = handlers.indexOf(messageHandler)
        if (index >= 0) {
          handlers.splice(index, 1)
        }
      }
    }
  }

  private async isRateLimited(client: string): Promise<boolean> {
    const {
      rateLimits,
      ipWhitelist = [],
    } = this.settings().limits?.message ?? {}

    if (ipWhitelist.includes(client)) {
      return false
    }

    const rateLimiter = this.slidingWindowRateLimiter()

    const hit = (period: number, rate: number) =>
      rateLimiter.hit(
        `${client}:message:${period}`,
        1,
        { period: period, rate: rate },
      )


    for (const { rate, period } of rateLimits) {
      const isRateLimited = await hit(period, rate)


      if (isRateLimited) {
        debug('rate limited %s: %d messages / %d ms exceeded', client, rate, period)

        return true
      }
    }

    return false
  }

  private onClientPong() {
    debugHeartbeat('client %s pong', this.clientId)
    this.alive = true
  }

  private onClientClose() {
    this.alive = false
    this.subscriptions.clear()

    const handlers = abortableMessageHandlers.get(this.client)
    if (Array.isArray(handlers) && handlers.length) {
      for (const handler of handlers) {
        handler.abort()
      }
    }

    this.removeAllListeners()
    this.client.removeAllListeners()

    debug('client %s closed', this.clientId)
  }
}
