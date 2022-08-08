import { IMessageHandler } from '../types/message-handlers'
import { MessageType, IncomingEventMessage } from '../types/messages'
import { IWebSocketServerAdapter } from '../types/servers'
import { IEventRepository } from '../types/repositories'
import { isEventSignatureValid } from '../utils/event'
import { WebSocket } from 'ws'

export class EventMessageHandler implements IMessageHandler {
  public constructor(
    private readonly eventRepository: IEventRepository,
  ) { }

  public canHandleMessageType(messageType: MessageType): boolean {
    return messageType === MessageType.EVENT
  }

  public async handleMessage(message: IncomingEventMessage, _client: WebSocket, adapter: IWebSocketServerAdapter): Promise<boolean> {
    if (!await isEventSignatureValid(message[1])) {
      console.warn(`Event ${message[1].id} from ${message[1].pubkey} with signature ${message[1].sig} is not valid`)
      return
    }

    try {
      const count = await this.eventRepository.create(message[1])
      if (!count) {
        return true
      }

      await adapter.broadcastEvent(message[1])

      return true
    } catch (error) {
      console.error(`Unable to add event. Reason: ${error.message}`)

      return false
    }
  }
}