import { EventEmitter } from 'node:stream'
import { WebSocket } from 'ws'

export interface IWebSocketServerAdapter extends EventEmitter {
  getConnectedClients(): number
  getClients(): Set<WebSocket>
  terminate(): Promise<void>
}

export interface IWebServerAdapter extends EventEmitter {
  listen(port: number)
}


export type IWebSocketAdapter = EventEmitter
