import { createEventCommandResult } from '../../telemetry/event-metrics'
import { createLogger } from '../../factories/logger-factory'
import { Event } from '../../@types/event'
import { IDvmJobRepository, IEventRepository } from '../../@types/repositories'
import { IEventStrategy } from '../../@types/message-handlers'
import { IWebSocketAdapter } from '../../@types/adapters'
import { WebSocketAdapterEvent } from '../../constants/adapter'

const logger = createLogger('dvm-job-request-event-strategy')

export class DvmJobRequestEventStrategy implements IEventStrategy<Event, Promise<void>> {
  public constructor(
    private readonly webSocket: IWebSocketAdapter,
    private readonly eventRepository: IEventRepository,
    private readonly dvmJobRepository: IDvmJobRepository,
  ) {}

  public async execute(event: Event): Promise<void> {
    logger('received dvm job request: %o', event)

    const count = await this.eventRepository.create(event)
    this.webSocket.emit(
      WebSocketAdapterEvent.Message,
      createEventCommandResult(event.id, true, count ? '' : 'duplicate:'),
    )

    if (!count) {
      return
    }

    this.webSocket.emit(WebSocketAdapterEvent.Broadcast, event)

    try {
      await this.dvmJobRepository.create(event.id, event.pubkey, event.kind)
    } catch (error) {
      // Job-state recording is best-effort: the event itself is already
      // stored and broadcast correctly, so a repository failure here must
      // not surface as a rejection of a valid event.
      logger.error('unable to record dvm job for event %s: %o', event.id, error)
    }
  }
}
