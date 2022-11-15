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
    private readonly settingsFactory: Factory<ISettings>,
  ) {
    super()
    this.alive = true
    this.subscriptions = new Map()

    this.clientId = Buffer.from(this.request.headers['sec-websocket-key'], 'base64').toString('hex')
    this.clientAddress = (this.request.headers['x-forwarded-for'] ?? this.request.socket.remoteAddress) as string

    debug('client %s from address %s', this.clientId, this.clientAddress)

    this.client
      .on('message', this.onClientMessage.bind(this))
      .on('close', this.onClientClose.bind(this))
      .on('pong', this.onClientPong.bind(this))

    this
      .on(WebSocketAdapterEvent.Heartbeat, this.onHeartbeat.bind(this))
      .on(WebSocketAdapterEvent.Subscribe, this.onSubscribed.bind(this))
      .on(WebSocketAdapterEvent.Unsubscribe, this.onUnsubscribed.bind(this))
      .on(WebSocketAdapterEvent.Event, this.onSendEvent.bind(this))
      .on(WebSocketAdapterEvent.Broadcast, this.onBroadcast.bind(this))
      .on(WebSocketAdapterEvent.Message, this.sendMessage.bind(this))

    debug('client %s connected', this.clientId)
  }

  public getClientId(): string {
    return this.clientId
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
    debug('client %s broadcast event: %o', this.clientId, event)
    this.webSocketServer.emit(WebSocketServerAdapterEvent.Broadcast, event)
    if (cluster.isWorker) {
      debug('client %s broadcast event to primary: %o', this.clientId, event)
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
    debug('sending message to client %s: %o', this.clientId, message)
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
    let abort: () => void
    try {
      if (await this.isRateLimited(this.clientAddress)) {
        this.sendMessage(createNoticeMessage('rate limited'))
        return
      }

      const message = attemptValidation(messageSchema)(JSON.parse(raw.toString('utf8')))

      const messageHandler = this.createMessageHandler([message, this]) as IMessageHandler & IAbortable
      if (typeof messageHandler?.abort === 'function') {
        abort = messageHandler.abort.bind(messageHandler)
        this.client.prependOnceListener('close', abort)
      }

      await messageHandler?.handleMessage(message)
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        debug('message handler aborted')
      } else if (error instanceof Error && error.name === 'ValidationError') {
        debug('invalid message: %o', (error as any).annotate())
        this.sendMessage(createNoticeMessage(`Invalid message: ${error.message}`))
      } else {
        debug('unable to handle message: %o', error)
      }
    } finally {
      if (abort) {
        this.client.removeListener('close', abort)
      }
    }
  }

  private async isRateLimited(client: string): Promise<boolean> {
    const {
      rateLimits,
      ipWhitelist = [],
    } = this.settingsFactory().limits?.message ?? {}

    if (ipWhitelist.includes(client)) {
      debug('rate limit check %s: skipped', client)
      return false
    }

    const rateLimiter = this.slidingWindowRateLimiter()

    const hit = (period: number, rate: number) =>
      rateLimiter.hit(
        `${client}:message:${period}`,
        1,
        { period: period, rate: rate },
      )

    const hits = await Promise.all(
      rateLimits
        .map(({ period, rate }) =>  hit(period, rate))
    )

    debug('rate limit check %s: %o = %o', client, rateLimits.map(({ period }) => period), hits)

    return hits.some((thresholdCrossed) => thresholdCrossed)
  }

  private onClientPong() {
    debugHeartbeat('client %s pong', this.clientId)
    this.alive = true
  }

  private onClientClose() {
    debug('client %s closing', this.clientId)
    this.alive = false

    this.removeAllListeners()
    this.client.removeAllListeners()

    debug('client %s closed', this.clientId)
  }
}
