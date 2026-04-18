import { createCommandResult } from '../../utils/messages'
import { createLogger } from '../../factories/logger-factory'
import { Event } from '../../@types/event'
import { EventKinds } from '../../constants/base'
import { IEventRepository } from '../../@types/repositories'
import { IEventStrategy } from '../../@types/message-handlers'
import { IWebSocketAdapter } from '../../@types/adapters'
import { WebSocketAdapterEvent } from '../../constants/adapter'

const debug = createLogger('vanish-event-strategy')

export class VanishEventStrategy implements IEventStrategy<Event, Promise<void>> {
  public constructor(
    private readonly webSocket: IWebSocketAdapter,
    private readonly eventRepository: IEventRepository,
  ) {}

  public async execute(event: Event): Promise<void> {
    debug('received request to vanish event: %o', event)

    await this.eventRepository.deleteByPubkeyExceptKinds(
      event.pubkey,
      [EventKinds.REQUEST_TO_VANISH],
    )

    const count = await this.eventRepository.create(event)

    this.webSocket.emit(
      WebSocketAdapterEvent.Message,
      createCommandResult(event.id, true, count ? '' : 'duplicate:')
    )
  }
}