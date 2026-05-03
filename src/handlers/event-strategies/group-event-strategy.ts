import { createCommandResult } from '../../utils/messages'
import { createLogger } from '../../factories/logger-factory'
import { Event } from '../../@types/event'
import { EventTags } from '../../constants/base'
import { IEventRepository } from '../../@types/repositories'
import { IEventStrategy } from '../../@types/message-handlers'
import { IWebSocketAdapter } from '../../@types/adapters'
import { WebSocketAdapterEvent } from '../../constants/adapter'

const logger = createLogger('group-event-strategy')

export class GroupEventStrategy implements IEventStrategy<Event, Promise<void>> {
  public constructor(
    private readonly webSocket: IWebSocketAdapter,
    private readonly eventRepository: IEventRepository,
  ) {}

  public async execute(event: Event): Promise<void> {
    logger('received group event: %o', event)

    const reason = this.validateGroupEvent(event)
    if (reason) {
      this.webSocket.emit(WebSocketAdapterEvent.Message, createCommandResult(event.id, false, `invalid: ${reason}`))
      return
    }

    const count = await this.eventRepository.create(event)
    this.webSocket.emit(WebSocketAdapterEvent.Message, createCommandResult(event.id, true, count ? '' : 'duplicate:'))

    if (count) {
      this.webSocket.emit(WebSocketAdapterEvent.Broadcast, event)
    }
  }

  // MIP-03: kind:445 Group Events MUST carry exactly one `h` tag whose value is the
  // 64-character lowercase hex-encoded nostr_group_id from the Marmot Group Data Extension.
  // The relay enforces this so that #h tag subscriptions always work correctly.
  private validateGroupEvent(event: Event): string | undefined {
    const groupTags = event.tags.filter((tag) => tag.length >= 2 && tag[0] === EventTags.Group)

    if (groupTags.length === 0) {
      return 'group event (kind 445) must have an h tag identifying the group'
    }

    if (groupTags.length > 1) {
      return 'group event (kind 445) must have exactly one h tag'
    }

    const groupId = groupTags[0][1]
    if (!/^[0-9a-f]{64}$/.test(groupId)) {
      return 'group event (kind 445) h tag must contain a valid 64-character lowercase hex group id'
    }

    return undefined
  }
}
