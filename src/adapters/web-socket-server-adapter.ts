import { IncomingMessage, Server } from 'http'
import { propEq } from 'ramda'
import WebSocket, { CLOSED, CLOSING, OPEN, RawData, WebSocketServer } from 'ws'

import { IWebSocketAdapter, IWebSocketServerAdapter } from '../@types/adapters'
import { Factory } from '../@types/base'
import { Event } from '../@types/event'
import { Settings } from '../@types/settings'
import { WebSocketAdapterEvent, WebSocketServerAdapterEvent } from '../constants/adapter'
import { createLogger } from '../factories/logger-factory'
import { isRateLimited } from '../handlers/request-handlers/rate-limiter-middleware'
import { getRemoteAddress } from '../utils/http'
import { getWsDrainTimeoutMs, isDraining } from '../utils/shutdown-state'
import { WebServerAdapter } from './web-server-adapter'

const logger = createLogger('web-socket-server-adapter')

const WSS_CLIENT_HEALTH_PROBE_INTERVAL = 120000

// A connection can send immediately after the handshake, before the async
// rate-limit check returns. Hold those frames briefly; bound the queue so a
// flood cannot turn a slow admission check into unbounded memory.
const MAX_EARLY_MESSAGE_COUNT = 64
const MAX_EARLY_MESSAGE_BYTES = 1024 * 1024

const rawDataByteLength = (data: RawData): number => {
  if (Buffer.isBuffer(data)) {
    return data.byteLength
  }

  if (Array.isArray(data)) {
    return data.reduce((total, chunk) => total + chunk.byteLength, 0)
  }

  return data.byteLength
}

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
    logger('closing')
    clearInterval(this.heartbeatInterval)
    void this.drainClients(getWsDrainTimeoutMs()).finally(() => {
      super.close(() => {
        logger('closing web socket server')
        this.webSocketServer.close(() => {
          this.webSocketServer.removeAllListeners()
          if (typeof callback !== 'undefined') {
            callback()
          }
          logger('closed')
        })
      })
      this.removeAllListeners()
    })
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

    // Attach before the awaited admission check: ws emits to whichever
    // listeners exist at the moment a frame arrives, and EventEmitter drops
    // events with no listener. Pause adds backpressure while we decide.
    const earlyMessages: { data: RawData; isBinary: boolean }[] = []
    let earlyBytes = 0
    let earlyOverflow = false

    const onEarlyMessage = (data: RawData, isBinary: boolean): void => {
      if (earlyMessages.length >= MAX_EARLY_MESSAGE_COUNT) {
        earlyOverflow = true
        return
      }

      const size = rawDataByteLength(data)
      if (earlyBytes + size > MAX_EARLY_MESSAGE_BYTES) {
        earlyOverflow = true
        return
      }

      earlyBytes += size
      earlyMessages.push({ data, isBinary })
    }


    let accepted = false
    try {
      if (await isRateLimited(remoteAddress, currentSettings)) {
        logger('client %s terminated: rate-limited', remoteAddress)
        client.terminate()
        return
      }

      if (earlyOverflow) {
        logger.warn('client %s closed: message backlog exceeded during admission', remoteAddress)
        client.close(1009, 'message backlog before admission')
        // Let the close handshake complete even though the socket was paused.
        client.resume()
        return
      }

      if (client.readyState !== OPEN) {
        // Admission can finish after the peer started closing. Resume before
        // leaving so the close handshake is not stuck behind the paused socket.
        client.resume()
        return
      }

      accepted = true
    } catch (error) {
      logger.error('client %s admission failed: %o', remoteAddress, error)
      client.terminate()
      return
    } finally {
      if (!accepted) {
        client.off('message', onEarlyMessage)
      }
    }

    try {
      this.webSocketsAdapters.set(client, this.createWebSocketAdapter([client, req, this]))
    } catch (error) {
      logger.error('client %s adapter creation failed: %o', remoteAddress, error)
      client.off('message', onEarlyMessage)
      client.terminate()
      return
    }

    // The adapter now owns the normal listener. Replay in arrival order before
    // resuming, so no buffered frame races a newly arrived one.
    client.off('message', onEarlyMessage)
    for (const early of earlyMessages) {
      client.emit('message', early.data, early.isBinary)
    }
    client.resume()
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
