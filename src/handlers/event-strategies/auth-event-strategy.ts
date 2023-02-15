import { createCommandResult } from '../../utils/messages'
import { createLogger } from '../../factories/logger-factory'
import { Event } from '../../@types/event'
import { IEventStrategy } from '../../@types/message-handlers'
import { isValidSignedAuthEvent } from '../../utils/event'
import { IWebSocketAdapter } from '../../@types/adapters'
import { WebSocketAdapterEvent } from '../../constants/adapter'

const permittedChallengeResponseTimeDelayMs = (1000 * 60 * 10) // 10 min
const debug = createLogger('default-event-strategy')

export class SignedAuthEventStrategy implements IEventStrategy<Event, Promise<void>> {
  public constructor(
    private readonly webSocket: IWebSocketAdapter,
  ) { }

  public async execute(event: Event): Promise<void> {
    debug('received signedAuth event: %o', event)
    const { challenge, createdAt } = this.webSocket.getClientAuthChallengeData()
    const verified = isValidSignedAuthEvent(event, challenge)

    const timeIsWithinBounds = (createdAt.getTime() + permittedChallengeResponseTimeDelayMs) > Date.now()

    debug('banana', timeIsWithinBounds, verified)
    if (verified && timeIsWithinBounds) {
      this.webSocket.setClientToAuthenticated()
      this.webSocket.emit(WebSocketAdapterEvent.Message, createCommandResult(event.id, true, 'authentication: succeeded'))
      return
    }

    this.webSocket.emit(WebSocketAdapterEvent.Message, createCommandResult(event.id, false, 'authentication: failed'))
  }
}
