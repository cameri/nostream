import { DashboardServerMessage, KPISnapshot } from '../types'
import { RawData, WebSocketServer } from 'ws'
import { createLogger } from '../../factories/logger-factory'
import WebSocket from 'ws'

const debug = createLogger('dashboard-service:ws')

export class DashboardWebSocketHub {
  public constructor(
    private readonly webSocketServer: WebSocketServer,
    private readonly getSnapshot: () => KPISnapshot,
  ) {
    console.info('dashboard-service: websocket hub initialized')

    this.webSocketServer
      .on('connection', this.onConnection.bind(this))
      .on('close', () => {
        console.info('dashboard-service: websocket server closed')
      })
      .on('error', (error) => {
        console.error('dashboard-service: websocket server error', error)
      })
  }

  public broadcastSnapshot(snapshot: KPISnapshot): void {
    this.broadcast({
      type: 'kpi.snapshot',
      payload: snapshot,
    })
  }

  public broadcastTick(sequence: number): void {
    this.broadcast({
      type: 'kpi.tick',
      payload: {
        at: new Date().toISOString(),
        sequence,
      },
    })
  }

  public close(): void {
    console.info('dashboard-service: closing websocket hub')
    this.webSocketServer.clients.forEach((client) => {
      client.close()
    })
    this.webSocketServer.removeAllListeners()
  }

  private onConnection(client: WebSocket): void {
    const connectedClients = this.getConnectedClientsCount()
    console.info('dashboard-service: websocket client connected (clients=%d)', connectedClients)

    client
      .on('close', (code, reason) => {
        console.info(
          'dashboard-service: websocket client disconnected (code=%d, reason=%s, clients=%d)',
          code,
          reason.toString(),
          this.getConnectedClientsCount(),
        )
      })
      .on('error', (error) => {
        console.error('dashboard-service: websocket client error', error)
      })
      .on('message', (raw) => {
        this.onClientMessage(raw)
      })

    this.send(client, {
      type: 'dashboard.connected',
      payload: {
        at: new Date().toISOString(),
      },
    })

    this.send(client, {
      type: 'kpi.snapshot',
      payload: this.getSnapshot(),
    })

    debug('dashboard websocket bootstrap snapshot sent')
  }

  private onClientMessage(raw: RawData): void {
    try {
      const rawMessage = this.toUtf8(raw)
      const message = JSON.parse(rawMessage)
      debug('dashboard websocket client message received: %o', message)
    } catch (error) {
      console.error('dashboard-service: websocket message parsing failed', error)
    }
  }

  private broadcast(message: DashboardServerMessage): void {
    this.webSocketServer.clients.forEach((client) => {
      if (client.readyState !== WebSocket.OPEN) {
        return
      }
      this.send(client, message)
    })
  }

  private send(client: WebSocket, message: DashboardServerMessage): void {
    if (client.readyState !== WebSocket.OPEN) {
      return
    }

    try {
      client.send(JSON.stringify(message))
    } catch (error) {
      console.error('dashboard-service: websocket send failed', error)
    }
  }

  private toUtf8(raw: RawData): string {
    if (typeof raw === 'string') {
      return raw
    }

    if (Buffer.isBuffer(raw)) {
      return raw.toString('utf8')
    }

    if (Array.isArray(raw)) {
      return raw.map((chunk) => {
        if (Buffer.isBuffer(chunk)) {
          return chunk.toString('utf8')
        }

        return Buffer.from(chunk as ArrayBuffer).toString('utf8')
      }).join('')
    }

    return Buffer.from(raw).toString('utf8')
  }

  private getConnectedClientsCount(): number {
    return Array.from(this.webSocketServer.clients).filter((client) => client.readyState === WebSocket.OPEN).length
  }
}
