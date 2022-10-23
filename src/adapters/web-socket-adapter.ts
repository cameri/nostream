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
import { Event } from '../@types/event'
import { Factory } from '../@types/base'
import { isEventMatchingFilter } from '../utils/event'
import { messageSchema } from '../schemas/message-schema'

export class WebSocketAdapter extends EventEmitter implements IWebSocketAdapter {
  private id: string
  private clientAddress: string
  private alive: boolean
  private subscriptions: Map<SubscriptionId, SubscriptionFilter[]>

  private sent = 0
  private received = 0

  public constructor(
    private readonly client: WebSocket,
    private readonly request: IncomingHttpMessage,
    private readonly webSocketServer: IWebSocketServerAdapter,
    private readonly createMessageHandler: Factory<IMessageHandler, [IncomingMessage, IWebSocketAdapter]>,
  ) {
    super()
    this.alive = true
    this.subscriptions = new Map()

    this.id = Buffer.from(this.request.headers['sec-websocket-key'], 'base64').toString('hex')
    this.clientAddress = this.request.headers['x-forwarded-for'] as string

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
      .on(WebSocketAdapterEvent.Message, this.onSendMessage.bind(this))
  }

  public onUnsubscribed(subscriptionId: string): void {
    this.subscriptions.delete(subscriptionId)
  }

  public onSubscribed(subscriptionId: string, filters: SubscriptionFilter[]): void {
    this.subscriptions.set(subscriptionId, filters)
  }

  public onBroadcast(event: Event): void {
    this.webSocketServer.emit(WebSocketServerAdapterEvent.Broadcast, event)
    process.send({
      eventName: WebSocketServerAdapterEvent.Broadcast,
      event,
    })
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
    this.sent++
    this.client.send(JSON.stringify(message))
  }

  private onSendMessage(message: OutgoingMessage): void {
    this.sendMessage(message)
  }

  public onHeartbeat(): void {
    if (!this.alive) {
      this.terminate()
      return
    }

    this.alive = false
    this.client.ping()
  }

  public getSubscriptions(): Map<string, SubscriptionFilter[]> {
    return new Map(this.subscriptions)
  }

  private terminate(): void {
    console.debug(`worker ${process.pid} - terminating client`)
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

      this.received++

      await messageHandler?.handleMessage(message)
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        console.error(`worker ${process.pid} - message handler aborted`)
      } else if (error instanceof Error && error.name === 'ValidationError') {
        console.error(`worker ${process.pid} -  invalid message`, (error as any).annotate())
        this.sendMessage(createNoticeMessage(`Invalid message: ${error.message}`))
      } else {
        console.error(`worker ${process.pid} - unable to handle message: ${error.message}`)
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
    console.debug(`worker ${process.pid} - client disconnected with code ${code}`)

    this.removeAllListeners()
    this.client.removeAllListeners()
  }
}
