import cluster from 'cluster'
import { EventEmitter } from 'stream'
import { IncomingMessage as IncomingHttpMessage } from 'http'
import { WebSocket } from 'ws'
import { ZodError } from 'zod'

import { ContextMetadata, Factory } from '../@types/base'
import {
  createAuthChallengeMessage,
  createClosedMessage,
  createNegErrMessage,
  createNoticeMessage,
  createOutgoingEventMessage,
} from '../utils/messages'
import { IAbortable, IMessageHandler } from '../@types/message-handlers'
import { IncomingMessage, MessageType, OutgoingMessage } from '../@types/messages'
import { INegentropySessions } from '../@types/negentropy'
import { NegentropySessions } from '../utils/negentropy-sessions'
import { IWebSocketAdapter, IWebSocketServerAdapter } from '../@types/adapters'
import { SubscriptionFilter, SubscriptionId } from '../@types/subscription'
import { WebSocketAdapterEvent, WebSocketServerAdapterEvent } from '../constants/adapter'
import { attemptValidation } from '../utils/validation'
import { ContextMetadataKey } from '../constants/base'
import { createLogger } from '../factories/logger-factory'
import { recordWebsocketConnectionClosed, recordWebsocketConnectionOpened } from '../telemetry/event-metrics'
import { Event } from '../@types/event'
import { getRemoteAddress } from '../utils/http'
import { createReadAuthorizationGuard } from '../utils/nip42'
import { Nip42SessionManager } from '../utils/nip42-session'
import { isConfiguredPeeringPeer } from '../utils/peering-auth'
import { messageLimitsFor } from '../utils/peer-limits'
import { IRateLimiter } from '../@types/utils'
import { isEventMatchingFilter } from '../utils/event'
import { isHidden } from '../utils/hidden-content-cache'
import { messageSchema } from '../schemas/message-schema'
import { Settings } from '../@types/settings'
import { SocketAddress } from 'net'

const logger = createLogger('web-socket-adapter')

/**
 * The NIP-01 type of a client frame, or `OTHER` when it is not one.
 *
 * The message limiter runs before validation — it has to, or a client could
 * spend the parse budget first — so it reads a bounded prefix instead of
 * decoding the frame. A frame that does not start with `["WORD"` shares the
 * `OTHER` bucket; it is refused a moment later anyway.
 */
const THROTTLED_MESSAGE_TYPES = new Set<string>([
  'REQ',
  'EVENT',
  'COUNT',
  'CLOSE',
  'AUTH',
  'NEG-OPEN',
  'NEG-MSG',
  'NEG-CLOSE',
])

const messageType = (raw: Buffer): string => {
  const prefix = raw.toString('utf8', 0, Math.min(raw.length, 32))
  const match = /^\s*\[\s*"([A-Za-z-]{1,8})"/.exec(prefix)
  const type = match ? match[1].toUpperCase() : ''

  // A closed set, not whatever the frame claims. Bucketing by an arbitrary word
  // would let a client rotate invented types (`["AAAA"]`, `["BBBB"]`, …) and
  // keep every bucket empty; anything unrecognised shares one bucket.
  return THROTTLED_MESSAGE_TYPES.has(type) ? type : 'OTHER'
}
const debugHeartbeat = logger.extend('heartbeat')

const abortableMessageHandlers: WeakMap<WebSocket, IAbortable[]> = new WeakMap()

export class WebSocketAdapter extends EventEmitter implements IWebSocketAdapter {
  public clientId: string
  private clientAddress: SocketAddress
  private alive: boolean
  private subscriptions: Map<SubscriptionId, SubscriptionFilter[]>
  private readonly session: Nip42SessionManager
  /** Configured peering peer proven by AUTH on this socket, if any. */
  private peerPubkey: string | undefined
  // NIP-77
  private readonly negentropySessions: NegentropySessions

  public constructor(
    private readonly client: WebSocket,
    private readonly request: IncomingHttpMessage,
    private readonly webSocketServer: IWebSocketServerAdapter,
    private readonly createMessageHandler: Factory<IMessageHandler, [IncomingMessage, IWebSocketAdapter]>,
    private readonly rateLimiter: Factory<IRateLimiter>,
    private readonly settings: Factory<Settings>,
  ) {
    super()
    this.alive = true
    this.subscriptions = new Map()
    this.negentropySessions = new NegentropySessions((subscriptionId) =>
      this.sendMessage(createNegErrMessage(subscriptionId, 'closed: negentropy session timed out')),
    )

    this.clientId = Buffer.from(this.request.headers['sec-websocket-key'] as string, 'base64').toString('hex')

    const address = getRemoteAddress(this.request, this.settings())

    this.clientAddress = new SocketAddress({
      address: address,
      family: address.indexOf(':') >= 0 ? 'ipv6' : 'ipv4',
    })

    this.client
      .on('error', (error) => {
        if (error.name === 'RangeError' && error.message === 'Max payload size exceeded') {
          logger.error(`web-socket-adapter: client ${this.clientId} (${this.getClientAddress()}) sent payload too large`)
        } else if (error.name === 'RangeError' && error.message === 'Invalid WebSocket frame: RSV1 must be clear') {
          logger(`client ${this.clientId} (${this.getClientAddress()}) enabled compression`)
        } else {
          logger.error(`web-socket-adapter: client error ${this.clientId} (${this.getClientAddress()}):`, error)
        }

        this.client.close()
      })
      .on('message', this.onClientMessage.bind(this))
      .on('close', this.onClientClose.bind(this))
      .on('pong', this.onClientPong.bind(this))
      .on('ping', this.onClientPing.bind(this))

    this.on(WebSocketAdapterEvent.Heartbeat, this.onHeartbeat.bind(this))
      .on(WebSocketAdapterEvent.Subscribe, this.onSubscribed.bind(this))
      .on(WebSocketAdapterEvent.Unsubscribe, this.onUnsubscribed.bind(this))
      .on(WebSocketAdapterEvent.Event, this.onSendEvent.bind(this))
      .on(WebSocketAdapterEvent.Broadcast, this.onBroadcast.bind(this))
      .on(WebSocketAdapterEvent.Message, this.sendMessage.bind(this))

    logger('client %s connected from %s', this.clientId, this.clientAddress.address)
    recordWebsocketConnectionOpened()

    // NIP-42: challenge-response session for this socket
    this.session = new Nip42SessionManager(() => this.settings().nip42?.sessionExpirySeconds)
    this.sendMessage(createAuthChallengeMessage(this.session.getChallenge()))
  }

  public getClientId(): string {
    return this.clientId
  }

  public getClientAddress(): string {
    return this.clientAddress.address
  }

  public onUnsubscribed(subscriptionId: string): void {
    logger('client %s unsubscribed %s', this.clientId, subscriptionId)
    this.subscriptions.delete(subscriptionId)
  }

  public onSubscribed(subscriptionId: string, filters: SubscriptionFilter[]): void {
    logger('client %s subscribed %s to %o', this.clientId, subscriptionId, filters)
    this.subscriptions.set(subscriptionId, filters)
  }

  public onBroadcast(event: Event): void {
    this.webSocketServer.emit(WebSocketServerAdapterEvent.Broadcast, event)
    if (cluster.isWorker && typeof process.send === 'function') {
      process.send({
        eventName: WebSocketServerAdapterEvent.Broadcast,
        event,
      })
    }
  }

  public onSendEvent(event: Event): void {
    // NIP-42: don't broadcast restricted-kind events to unauthorized clients.
    const isReadAuthorized = createReadAuthorizationGuard(this.settings(), () => this.session.getAuthenticatedPubkeys())
    if (!isReadAuthorized(event)) {
      return
    }

    // NIP-56: keep live subscriptions consistent with what a fresh REQ would
    // now exclude -- EventRepository's hiding only applies to DB queries, so
    // this in-memory check covers the broadcast path the same way.
    const nip56 = this.settings().nip56
    if (nip56?.enabled && nip56?.hideActionableReports && isHidden(event)) {
      return
    }

    this.subscriptions.forEach((filters, subscriptionId) => {
      if (filters.map(isEventMatchingFilter).some((isMatch) => isMatch(event))) {
        logger('sending event to client %s: %o', this.clientId, event)
        this.sendMessage(createOutgoingEventMessage(subscriptionId, event))
      }
    })
  }

  private sendMessage(message: OutgoingMessage): void {
    if (this.client.readyState !== WebSocket.OPEN) {
      return
    }
    this.client.send(JSON.stringify(message))
  }

  public onHeartbeat(): void {
    if (!this.alive) {
      logger.error(`web-socket-adapter: pong timeout for client ${this.clientId} (${this.getClientAddress()})`)
      this.client.close()
      return
    }

    this.alive = false
    this.client.ping()
    debugHeartbeat('client %s ping', this.clientId)
  }

  public getSubscriptions(): Map<string, SubscriptionFilter[]> {
    return new Map(this.subscriptions)
  }

  public drainAndClose(reason = 'relay shutting down'): void {
    this.subscriptions.forEach((_filters, subscriptionId) => {
      this.sendMessage(createClosedMessage(subscriptionId, `error: ${reason}`))
    })

    this.negentropySessions.getSessionIds().forEach((subscriptionId) => {
      this.sendMessage(createNegErrMessage(subscriptionId, `closed: ${reason}`))
    })
    this.negentropySessions.closeAll()

    if (this.client.readyState === WebSocket.OPEN) {
      this.client.close(1001, reason)
    }
  }

  // NIP-77
  public getNegentropySessions(): INegentropySessions {
    return this.negentropySessions
  }

  // NIP-42
  public getChallenge(): string {
    return this.session.getChallenge()
  }

  public getAuthenticatedPubkeys(): ReadonlySet<string> {
    return this.session.getAuthenticatedPubkeys()
  }

  public addAuthenticatedPubkey(pubkey: string, authEventId: string): boolean {
    // Keep the existing challenge. NIP-42 allows multiple AUTH events on one
    // socket to share it; rotating here would break pipelined multi-pubkey auth.
    return this.session.authenticate(pubkey, authEventId)
  }

  public getPeerPubkey(): string | undefined {
    if (!this.peerPubkey) {
      return undefined
    }

    // Peer status lives and dies with its AUTH session, and with the operator's
    // current trust list: disabling or removing the peer revokes it on the next
    // read even if the socket stays authenticated.
    if (
      !this.session.getAuthenticatedPubkeys().has(this.peerPubkey) ||
      !isConfiguredPeeringPeer(this.settings(), this.peerPubkey)
    ) {
      this.peerPubkey = undefined
      return undefined
    }

    return this.peerPubkey
  }

  public setPeerPubkey(pubkey: string): void {
    const authenticated = this.session.getAuthenticatedPubkeys().has(pubkey)
    this.peerPubkey = authenticated && isConfiguredPeeringPeer(this.settings(), pubkey) ? pubkey : undefined
  }

  private async onClientMessage(raw: Buffer) {
    this.alive = true
    let abortable = false
    let messageHandler: (IMessageHandler & IAbortable) | undefined = undefined
    try {
      const retryAfterMs = await this.isRateLimited(this.clientAddress.address, messageType(raw))
      if (retryAfterMs) {
        this.sendMessage(this.createRateLimitedMessage(raw, retryAfterMs))
        return
      }

      const message = attemptValidation(messageSchema)(JSON.parse(raw.toString('utf8')))

      message[ContextMetadataKey] = {
        remoteAddress: this.clientAddress,
      } as ContextMetadata

      messageHandler = this.createMessageHandler([message, this]) as IMessageHandler & IAbortable
      if (!messageHandler) {
        logger.error('web-socket-adapter: unhandled message: no handler found:', message)
        return
      }

      abortable = typeof messageHandler.abort === 'function'

      if (abortable) {
        const handlers = abortableMessageHandlers.get(this.client) ?? []
        handlers.push(messageHandler)
        abortableMessageHandlers.set(this.client, handlers)
      }

      await messageHandler.handleMessage(message)
    } catch (error) {
      if (error instanceof Error) {
        if (error.name === 'AbortError') {
          logger.error(`web-socket-adapter: abort from client ${this.clientId} (${this.getClientAddress()})`)
        } else if (error.name === 'SyntaxError' || error instanceof ZodError) {
          logger('invalid message client %s (%s): %s', this.clientId, this.getClientAddress(), error.message)
          const notice =
            error instanceof ZodError
              ? `invalid: ${error.issues[0]?.message ?? error.message}`
              : `invalid: ${error.message}`
          this.sendMessage(createNoticeMessage(notice))
        } else {
          logger.error('web-socket-adapter: unable to handle message:', error)
        }
      } else {
        logger.error('web-socket-adapter: unable to handle message:', error)
      }
    } finally {
      if (abortable && messageHandler) {
        const handlers = abortableMessageHandlers.get(this.client)
        if (handlers) {
          const index = handlers.indexOf(messageHandler)
          if (index >= 0) {
            handlers.splice(index, 1)
          }
        }
      }
    }
  }

  /**
   * Resolves to false when allowed; otherwise to the backoff in ms, sent as the
   * NIP-01 `rate-limited` parameter.
   *
   * The bucket carries the message type: a client told to back off should back
   * off *the message that tripped the limit*. One shared bucket refused a REQ
   * because its EVENTs had filled it, which is the wrong message to punish and
   * the wrong one to throttle.
   */
  private async isRateLimited(client: string, type: string): Promise<false | number> {
    const isPeer = this.getPeerPubkey() !== undefined
    const { rateLimits, ipWhitelist = [] } = messageLimitsFor(this.settings(), isPeer) ?? {}

    if (!Array.isArray(rateLimits) || !rateLimits.length || ipWhitelist.includes(client)) {
      return false
    }

    const rateLimiter = this.rateLimiter()

    // Peer buckets are separate so a connection that spent client budget before
    // AUTH does not carry that score into feed treatment.
    const bucket = isPeer ? 'peer-message' : 'message'
    const hit = (period: number, rate: number) =>
      rateLimiter.hit(`${client}:${bucket}:${type}:${period}`, 1, { period, rate })

    for (const { rate, period } of rateLimits) {
      const result = await hit(period, rate)

      if (result.limited) {
        logger('rate limited %s (%s): %d messages / %d ms exceeded', client, type, rate, period)

        return result.retryAfterMs ?? Math.max(1, Math.ceil(period))
      }
    }

    return false
  }

  // NIP-01: reads (REQ, COUNT) are refused with CLOSED; other messages keep the NOTICE.
  private createRateLimitedMessage(raw: Buffer, retryAfterMs: number): OutgoingMessage {
    let message: unknown
    try {
      message = JSON.parse(raw.toString('utf8'))
    } catch {
      return createNoticeMessage('rate limited')
    }

    if (
      Array.isArray(message) &&
      (message[0] === MessageType.REQ || message[0] === MessageType.COUNT) &&
      typeof message[1] === 'string'
    ) {
      if (message[0] === MessageType.REQ) {
        this.endSubscription(message[1])
      }

      return createClosedMessage(message[1], 'rate-limited: slow down', String(retryAfterMs))
    }

    return createNoticeMessage('rate limited')
  }

  private endSubscription(subscriptionId: SubscriptionId): void {
    this.abortInFlightSubscriptionReads(subscriptionId)
    if (this.subscriptions.has(subscriptionId)) {
      this.onUnsubscribed(subscriptionId)
    }
  }

  private abortInFlightSubscriptionReads(subscriptionId: SubscriptionId): void {
    const handlers = abortableMessageHandlers.get(this.client)
    if (!handlers?.length) {
      return
    }

    for (const handler of handlers) {
      const abortable = handler as IAbortable & { activeSubscriptionId?: SubscriptionId }
      if (abortable.activeSubscriptionId === subscriptionId && typeof abortable.abort === 'function') {
        try {
          abortable.abort()
        } catch (error) {
          logger.error('Unable to abort subscription handler for %s: %o', subscriptionId, error)
        }
      }
    }
  }

  private onClientPong() {
    debugHeartbeat('client %s pong', this.clientId)
    this.alive = true
  }

  private onClientPing(data: any) {
    debugHeartbeat('client %s ping', this.clientId)
    this.client.pong(data)
    this.alive = true
  }

  private onClientClose() {
    recordWebsocketConnectionClosed()
    this.alive = false
    this.subscriptions.clear()
    this.negentropySessions.closeAll()
    this.session.clear()
    this.peerPubkey = undefined

    const handlers = abortableMessageHandlers.get(this.client)
    if (Array.isArray(handlers) && handlers.length) {
      for (const handler of handlers) {
        try {
          handler.abort()
        } catch (error) {
          logger.error('Unable to abort message handler', error)
        }
      }
    }

    this.removeAllListeners()
    this.client.removeAllListeners()
  }
}
