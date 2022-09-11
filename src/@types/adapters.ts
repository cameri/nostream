import { EventEmitter } from 'node:stream'

export interface IWebSocketServerAdapter extends EventEmitter {
  getConnectedClients(): number
  terminate(): Promise<void>
}

export interface IWebServerAdapter extends EventEmitter {
  listen(port: number)
}


export type IWebSocketAdapter = EventEmitter
