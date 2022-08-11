import { WebSocket } from 'ws'

import { Message } from './messages'

export interface IMessageHandler {
  handleMessage(message: Message, client: WebSocket): Promise<void>
}

export interface IAbortable {
  abort(): void
}

export interface IEventStrategy<TInput, TOutput> {
  execute(args: TInput): TOutput
}
