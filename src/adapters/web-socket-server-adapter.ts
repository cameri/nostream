import { IncomingMessage, Server } from 'http'
import WebSocket, { CLOSED, CLOSING, OPEN, WebSocketServer } from 'ws'
import { propEq } from 'ramda'

import { IWebSocketAdapter, IWebSocketServerAdapter } from '../@types/adapters'
import { WebSocketAdapterEvent, WebSocketServerAdapterEvent } from '../constants/adapter'
import { createLogger } from '../factories/logger-factory'
import { Event } from '../@types/event'
import { Factory } from '../@types/base'
import { getRemoteAddress } from '../utils/http'
import { isRateLimited } from '../handlers/request-handlers/rate-limiter-middleware'
import { Settings } from '../@types/settings'
import { getWsDrainTimeoutMs, isDraining } from '../utils/shutdown-state'
import { WebServerAdapter } from './web-server-adapter'

const logger = createLogger('web-socket-server-adapter')

const WSS_CLIENT_HEALTH_PROBE_INTERVAL = 120000

export class WebSocketServerAdapter extends WebServerAdapter implements IWebSocketServerAdapter {
  private webSocketsAdapters: WeakMap<WebSocket, IWebSocketAdapter>

  private heartbeatInterval: NodeJS.Timeout

  public constructor(
    webServer: Server,
    private readonly webSocketServer: WebSocketServer,
    private readonly createWebSocketAdapter: Factory<
      IWebSocketAdapter,
      [WebSocket, IncomingMessage, IWebSocketServerAdapter]
    >,
    private readonly settings: () => Settings,
  ) {
    logger('created')
    super(webServer)

    this.webSocketsAdapters = new WeakMap()

    this.on(WebSocketServerAdapterEvent.Broadcast, this.onBroadcast.bind(this))

    this.webSocketServer
      .on(WebSocketServerAdapterEvent.Connection, this.onConnection.bind(this))
      .on('error', (error) => {
        logger('error: %o', error)
      })
    this.heartbeatInterval = setInterval(this.onHeartbeat.bind(this), WSS_CLIENT_HEALTH_PROBE_INTERVAL)
  }

  public close(callback?: () => void): void {
    super.close(() => {
      logger('closing')
      clearInterval(this.heartbeatInterval)
      void this.drainClients(getWsDrainTimeoutMs()).finally(() => {
        logger('closing web socket server')
        this.webSocketServer.close(() => {
          this.webSocketServer.removeAllListeners()
          if (typeof callback !== 'undefined') {
            callback()
          }
          logger('closed')
        })
      })
    })
    this.removeAllListeners()
  }

  private async drainClients(timeoutMs: number): Promise<void> {
    const clients = [...this.webSocketServer.clients] as WebSocket[]
    if (clients.length === 0) {
      return
    }

    logger('draining %d websocket client(s)', clients.length)

    for (const webSocket of clients) {
      const webSocketAdapter = this.webSocketsAdapters.get(webSocket)
      if (webSocketAdapter) {
        logger('closing client %s: %s', webSocketAdapter.getClientId(), webSocketAdapter.getClientAddress())
        webSocketAdapter.drainAndClose()
      } else if (webSocket.readyState === OPEN) {
        webSocket.close(1001, 'relay shutting down')
      }
    }

    await Promise.race([
      Promise.all(clients.map((webSocket) => this.waitForWebSocketClose(webSocket))),
      new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
    ])

    for (const webSocket of this.webSocketServer.clients) {
      if (webSocket.readyState === OPEN || webSocket.readyState === CLOSING) {
        logger('terminating client after drain timeout')
        webSocket.terminate()
      }
    }
  }

  private waitForWebSocketClose(webSocket: WebSocket): Promise<void> {
    if (webSocket.readyState === CLOSED) {
      return Promise.resolve()
    }

    return new Promise((resolve) => {
      webSocket.once('close', () => resolve())
    })
  }

  private onBroadcast(event: Event) {
    this.webSocketServer.clients.forEach((webSocket: WebSocket) => {
      if (!propEq('readyState', OPEN)(webSocket)) {
        return
      }
      const webSocketAdapter = this.webSocketsAdapters.get(webSocket) as IWebSocketAdapter
      if (!webSocketAdapter) {
        return
      }
      webSocketAdapter.emit(WebSocketAdapterEvent.Event, event)
    })
  }

  public getConnectedClients(): number {
    return Array.from(this.webSocketServer.clients).filter(propEq('readyState', OPEN)).length
  }

  private async onConnection(client: WebSocket, req: IncomingMessage) {
    if (isDraining()) {
      logger('client rejected: draining')
      client.close(1001, 'relay shutting down')
      return
    }

    const currentSettings = this.settings()
    const remoteAddress = getRemoteAddress(req, currentSettings)

    logger('client %s connected: %o', remoteAddress, req.headers)

    if (await isRateLimited(remoteAddress, currentSettings)) {
      logger('client %s terminated: rate-limited', remoteAddress)
      client.terminate()
      return
    }

    this.webSocketsAdapters.set(client, this.createWebSocketAdapter([client, req, this]))
  }

  private onHeartbeat() {
    this.webSocketServer.clients.forEach((webSocket) => {
      const webSocketAdapter = this.webSocketsAdapters.get(webSocket) as IWebSocketAdapter
      if (webSocketAdapter) {
        webSocketAdapter.emit(WebSocketAdapterEvent.Heartbeat)
      }
    })
  }
}
