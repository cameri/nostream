import { Event } from '../../@types/event'
import { EventTags } from '../../constants/base'
import { IEventRepository } from '../../@types/repositories'
import { IEventStrategy } from '../../@types/message-handlers'
import { IWebSocketAdapter } from '../../@types/adapters'
import { WebSocketAdapterEvent } from '../../constants/adapter'


export class DeleteEventStrategy implements IEventStrategy<Event, Promise<void>> {
  public constructor(
    private readonly webSocket: IWebSocketAdapter,
    private readonly eventRepository: IEventRepository,
  ) { }

  public async execute(event: Event): Promise<void> {
    const eTags = event.tags.filter((tag) => tag[0] === EventTags.Event)

    if (!eTags.length) {
      return
    }

    const count = await this.eventRepository.create(event)
    if (!count) {
      return
    }

    await this.eventRepository.deleteByPubkeyAndIds(
      event.pubkey,
      eTags.map((tag) => tag[1])
    )
    this.webSocket.emit(WebSocketAdapterEvent.Broadcast, event)
  }

}
