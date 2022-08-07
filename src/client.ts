import { WebSocket } from 'ws'

import { IClient } from './types/clients'
import { Message } from './types/messages'

export class Client implements IClient {
  public constructor(
    private readonly websocket: WebSocket
  ) { }

  public from(websocket: WebSocket): IClient {
    return new Client(websocket)
  }

  public isConnected(): boolean {
    return this.websocket.readyState === WebSocket.OPEN
  }

  public send(message: Message): void {
    this.websocket.send(JSON.stringify(message))
  }

}