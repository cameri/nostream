import { IEventRepository, IUserRepository } from '../../@types/repositories'
import { createEventCommandResult } from '../../telemetry/event-metrics'
import { createLogger } from '../../factories/logger-factory'
import { Event } from '../../@types/event'
import { EventKinds } from '../../constants/base'
import { IEventStrategy } from '../../@types/message-handlers'
import { IWebSocketAdapter } from '../../@types/adapters'
import { MembershipListPublisher } from '../../utils/nip43-membership'
import { WebSocketAdapterEvent } from '../../constants/adapter'

const logger = createLogger('vanish-event-strategy')

export class VanishEventStrategy implements IEventStrategy<Event, Promise<void>> {
  public constructor(
    private readonly webSocket: IWebSocketAdapter,
    private readonly eventRepository: IEventRepository,
    private readonly userRepository: IUserRepository,
    private readonly membershipList?: MembershipListPublisher,
  ) {}

  public async execute(event: Event): Promise<void> {
    logger('received request to vanish event: %o', event)

    await this.eventRepository.deleteByPubkeyExceptKinds(event.pubkey, [EventKinds.REQUEST_TO_VANISH])

    const count = await this.eventRepository.create(event)

    await this.userRepository.setVanished(event.pubkey, true)

    // A member who vanishes is left out of the published membership list, which only changes when it is refreshed.
    // The vanish itself is done whether or not the list could be refreshed.
    try {
      await this.membershipList?.refresh()
    } catch (error) {
      logger('unable to refresh the membership list after %s vanished: %o', event.pubkey, error)
    }

    this.webSocket.emit(WebSocketAdapterEvent.Message, createEventCommandResult(event.id, true, count ? '' : 'duplicate:'))
  }
}
