import { EventEmitter } from 'stream'
import { IncomingMessage as IncomingHttpMessage } from 'http'
import { WebSocket } from 'ws'

import { IAbortable, IMessageHandler } from '../@types/message-handlers'
import { IncomingMessage, OutgoingMessage } from '../@types/messages'
import { IWebSocketAdapter, IWebSocketServerAdapter } from '../@types/adapters'
import { SubscriptionFilter, SubscriptionId } from '../@types/subscription'
import { attemptValidation } from '../utils/validation'
import { createOutgoingEventMessage } from '../utils/messages'
import { Event } from '../@types/event'
import { Factory } from '../@types/base'
import { isEventMatchingFilter } from '../utils/event'
import { messageSchema } from '../schemas/message-schema'

export class WebSocketAdapter extends EventEmitter implements IWebSocketAdapter {
  private id: string
  private clientAddress: string
  private alive: boolean
  private subscriptions: Map<SubscriptionId, Set<SubscriptionFilter>>

  public constructor(
    private readonly client: WebSocket,
    private readonly request: IncomingHttpMessage,
    private readonly webSocketServer: IWebSocketServerAdapter,
    private readonly createMessageHandler: Factory<IMessageHandler, [IncomingMessage, IWebSocketAdapter]>,
  ) {
    super()
    this.alive = true
    this.subscriptions = new Map()

    this.id = Buffer.from(request.headers['sec-websocket-key'], 'base64').toString('hex')
    this.clientAddress = request.headers['x-forwarded-for'] as string

    this.client
      .on('message', this.onClientMessage.bind(this))
      .on('close', this.onClientClose.bind(this))
      .on('pong', this.onClientPong.bind(this))

    this
      .on('heartbeat', this.onHeartbeat.bind(this))
      .on('subscribe', this.onSubscribed.bind(this))
      .on('unsubscribe', this.onUnsubscribed.bind(this))
      .on('broadcast', this.onBroadcast.bind(this))
  }

  public getWebSocketServer(): IWebSocketServerAdapter {
    return this.webSocketServer
  }

  public onUnsubscribed(subscriptionId: string): void {
    this.subscriptions.delete(subscriptionId)
  }

  public onSubscribed(subscriptionId: string, filters: Set<SubscriptionFilter>): void {
    this.subscriptions.set(subscriptionId, filters)
  }

  public onBroadcast(event: Event): void {
    this.subscriptions.forEach((filters, subscriptionId) => {
      if (
        Array.from(filters).map(isEventMatchingFilter).some((Matches) => Matches(event))
      ) {
        this.sendMessage(createOutgoingEventMessage(subscriptionId, event))
      }
    })
  }

  public sendMessage(message: OutgoingMessage): void {
    this.client.send(JSON.stringify(message))
  }

  public onHeartbeat(): void {
    if (!this.alive) {
      this.terminate()
      return
    }

    this.alive = false
    this.client.ping()
  }

  public getSubscriptions(): Map<string, Set<SubscriptionFilter>> {
    return new Map(this.subscriptions)
  }

  private terminate(): void {
    this.client.terminate()
  }

  private async onClientMessage(raw: Buffer) {
    let abort
    try {
      const message = attemptValidation(messageSchema)(JSON.parse(raw.toString('utf-8')))

      const messageHandler = this.createMessageHandler([message, this]) as IMessageHandler & IAbortable
      if (typeof messageHandler.abort === 'function') {
        abort = messageHandler.abort.bind(messageHandler)
        this.client.prependOnceListener('close', abort)
      }

      await messageHandler?.handleMessage(message)
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        console.error('Message handler aborted')
      } else if (error instanceof Error && error.name === 'ValidationError') {
        console.error('Invalid message', (error as any).annotate())
      } else {
        console.error(`Unable to handle message: ${error.message}`)
      }
    } finally {
      if (abort) {
        this.client.removeListener('close', abort)
      }
    }
  }

  private onClientPong() {
    this.alive = true
  }

  private onClientClose(code: number) {
    this.alive = false
    const connected = this.webSocketServer.getConnectedClients()
    console.debug(`client disconnected code ${code} - ${connected}/${this.webSocketServer.getClients().size} clients connected`)

    this.removeAllListeners()
    this.client.removeAllListeners()
  }
}
