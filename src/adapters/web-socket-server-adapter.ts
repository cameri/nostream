import { Server } from 'http'
import WebSocket, { WebSocketServer } from 'ws'

import { isEventMatchingFilter } from '../utils/event'
import { createOutgoingEventMessage } from '../messages'
import { Event } from '../types/event'
import { IMessageHandler } from '../types/message-handlers'
import { Message } from '../types/messages'
import { IWebSocketServerAdapter } from '../types/servers'
import { SubscriptionId, SubscriptionFilter } from '../types/subscription'
import { WebServerAdapter } from './web-server-adapter'

const WSS_CLIENT_HEALTH_PROBE_INTERVAL = 30000

export class WebSocketServerAdapter extends WebServerAdapter implements IWebSocketServerAdapter {
  private subscriptions: WeakMap<
    WebSocket,
    Map<SubscriptionId, SubscriptionFilter[]>
  >
  private heartbeats: WeakMap<WebSocket, boolean>

  private readonly handlers: IMessageHandler[] = []

  private heartbeatInterval: NodeJS.Timer

  public constructor(
    webServer: Server,
    private readonly webSocketServer: WebSocketServer,
  ) {
    super(webServer)

    this.subscriptions = new WeakMap<WebSocket,
      Map<SubscriptionId, SubscriptionFilter[]>>()
    this.heartbeats = new WeakMap<WebSocket, boolean>()

    this.webSocketServer.on('connection', this.onWebSocketServerConnection.bind(this))
    this.webSocketServer.on('close', this.onWebSocketServerClose.bind(this))
    this.heartbeatInterval = setInterval(this.onWebSocketServerHeartbeat.bind(this), WSS_CLIENT_HEALTH_PROBE_INTERVAL)
  }

  public addMessageHandler(messageHandler: IMessageHandler): void {
    this.handlers.push(messageHandler)
  }

  public getSubscriptions(client: WebSocket): Map<string, SubscriptionFilter[]> | undefined {
    return this.subscriptions.get(client)
  }

  public async broadcastEvent(event: Event): Promise<void> {
    this.webSocketServer.clients.forEach((client: WebSocket) => {
      if (client.readyState !== WebSocket.OPEN) {
        return
      }
      this.subscriptions.get(client)?.forEach((filters, subscriptionId) => {
        if (
          !filters.map(isEventMatchingFilter).some((isMatch) => isMatch(event))
        ) {
          return
        }

        console.log('Event sent', event.id)

        client.send(
          JSON.stringify(createOutgoingEventMessage(subscriptionId, event))
        )
      })
    })
  }

  private onWebSocketServerConnection(client: WebSocket) {
    this.heartbeats.set(client, true)
    this.subscriptions.set(client, new Map())

    client.on('message', (raw: WebSocket.RawData) => {
      try {
        const message = JSON.parse(raw.toString('utf-8'))
        this.onWebSocketClientMessage(client, message)
      } catch (error) {
        console.error('Unable to parse message', raw.toString('utf-8'))
      }
    })

    client.on('close', (_code: number) => {
      this.onWebSocketClientClose(client)
    })

    client.on('pong', () => this.onWebSocketClientPong.call(this, client))
  }

  private async onWebSocketClientMessage(client: WebSocket, message: Message) {
    for (const handler of this.handlers) {
      if (handler.canHandleMessageType(message[0])) {
        const handled = await handler.handleMessage(message, client, this)
        if (handled) {
          break
        }
      }
    }
  }

  private onWebSocketClientPong(client: WebSocket) {
    this.heartbeats.set(client, true)
  }

  private onWebSocketServerHeartbeat() {
    this.webSocketServer.clients.forEach((client) => {
      if (!this.heartbeats.get(client)) {
        console.warn('terminating client')
        client.terminate()
        return
      }

      this.heartbeats.set(client, false)
      client.ping()
    })
  }

  private onWebSocketServerClose() {
    clearInterval(this.heartbeatInterval)
  }

  private onWebSocketClientClose(client: WebSocket) {
    this.subscriptions.delete(client)

    client.removeAllListeners()
  }
}