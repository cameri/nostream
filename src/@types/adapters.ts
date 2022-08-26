import { EventEmitter } from 'node:stream'
import { WebSocket } from 'ws'

import { Event } from './event'
import { OutgoingMessage } from './messages'

export interface IWebSocketServerAdapter {
  getConnectedClients(): number
  getClients(): Set<WebSocket>
  broadcastEvent(event: Event): Promise<void>
}

export interface IWebServerAdapter extends EventEmitter {
  listen(port: number)
}


export interface IWebSocketAdapter extends EventEmitter {
  getWebSocketServer(): IWebSocketServerAdapter
  sendMessage(message: OutgoingMessage): void
}
