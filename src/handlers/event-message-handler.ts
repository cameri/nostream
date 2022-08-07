import { IMessageHandler } from '../types/message-handlers'
import { MessageType, IncomingEventMessage } from '../types/messages'
import { IWebSocketServerAdapter } from '../types/servers'
import { IEventRepository } from '../types/repositories'

export class EventMessageHandler implements IMessageHandler {
  public constructor(
    private readonly adapter: IWebSocketServerAdapter,
    private readonly eventRepository: IEventRepository,
  ) { }

  public canHandleMessageType(messageType: MessageType): boolean {
    return messageType === MessageType.EVENT
  }

  public async handleMessage(message: IncomingEventMessage): Promise<boolean> {
    // TODO: validate
    try {
      const count = await this.eventRepository.create(message[1])
      if (!count) {
        console.debug('Event already exists.')
        return true
      }

      await this.adapter.broadcastEvent(message[1])

      return true
    } catch (error) {
      console.error(`Unable to add event. Reason: ${error.message}`)

      return false
    }
  }
}