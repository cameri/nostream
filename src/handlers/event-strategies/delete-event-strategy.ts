import { Event } from '../../@types/event'
import { EventTags } from '../../constants/base'
import { IEventRepository } from '../../@types/repositories'
import { IEventStrategy } from '../../@types/message-handlers'


export class DeleteEventStrategy implements IEventStrategy<Event, Promise<boolean>> {
  public constructor(
    private readonly eventRepository: IEventRepository,
  ) { }

  public async execute(event: Event): Promise<boolean> {
    try {
      const eTags = event.tags.filter((tag) => tag[0] === EventTags.Event)

      if (!eTags.length) {
        return
      }

      await this.eventRepository.deleteByPubkeyAndIds(
        event.pubkey,
        eTags.map((tag) => tag[1])
      )

      return
    } catch (error) {
      console.error('Unable to handle event. Reason:', error)

      return false
    }
  }

}
