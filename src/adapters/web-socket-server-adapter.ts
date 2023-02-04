import { IncomingMessage, Server } from 'http'
import WebSocket, { OPEN, WebSocketServer } from 'ws'
import { propEq } from 'ramda'

import { IWebSocketAdapter, IWebSocketServerAdapter } from '../@types/adapters'
import { WebSocketAdapterEvent, WebSocketServerAdapterEvent } from '../constants/adapter'
import { createLogger } from '../factories/logger-factory'
import { Event } from '../@types/event'
import { Factory } from '../@types/base'
import { getRemoteAddress } from '../utils/http'
import { isRateLimited } from '../handlers/request-handlers/rate-limiter-middleware'
import { Settings } from '../@types/settings'
import { WebServerAdapter } from './web-server-adapter'

const debug = createLogger('web-socket-server-adapter')

const WSS_CLIENT_HEALTH_PROBE_INTERVAL = 120000

export class WebSocketServerAdapter extends WebServerAdapter implements IWebSocketServerAdapter {
  private webSocketsAdapters: WeakMap<WebSocket, IWebSocketAdapter>

  private heartbeatInterval: NodeJS.Timer

  public constructor(
    webServer: Server,
    private readonly webSocketServer: WebSocketServer,
    private readonly createWebSocketAdapter: Factory<
      IWebSocketAdapter,
      [WebSocket, IncomingMessage, IWebSocketServerAdapter]
    >,
    private readonly settings: () => Settings,
  ) {
    debug('created')
    super(webServer)

    this.webSocketsAdapters = new WeakMap()

    this
      .on(WebSocketServerAdapterEvent.Broadcast, this.onBroadcast.bind(this))

    this.webSocketServer
      .on(WebSocketServerAdapterEvent.Connection, this.onConnection.bind(this))
      .on('error', (error) => {
        debug('error: %o', error)
      })
    this.heartbeatInterval = setInterval(this.onHeartbeat.bind(this), WSS_CLIENT_HEALTH_PROBE_INTERVAL)
  }

  public close(callback?: () => void): void {
    super.close(() => {
      debug('closing')
      clearInterval(this.heartbeatInterval)
      this.webSocketServer.clients.forEach((webSocket: WebSocket) => {
        const webSocketAdapter = this.webSocketsAdapters.get(webSocket)
        if (webSocketAdapter) {
          debug('terminating client %s: %s', webSocketAdapter.getClientId(), webSocketAdapter.getClientAddress())
        }
        webSocket.terminate()
      })
      debug('closing web socket server')
      this.webSocketServer.close(() => {
        this.webSocketServer.removeAllListeners()
        if (typeof callback !== 'undefined') {
          callback()
        }
        debug('closed')
      })
    })
    this.removeAllListeners()
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
    const currentSettings = this.settings()
    const remoteAddress = getRemoteAddress(req, currentSettings)

    debug('client %s connected: %o', remoteAddress, req.headers)

    if (await isRateLimited(remoteAddress, currentSettings)) {
      debug('client %s terminated: rate-limited', remoteAddress)
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
