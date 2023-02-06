import { createLogger } from '../../factories/logger-factory'
import { Event } from '../../@types/event'
import { IEventStrategy } from '../../@types/message-handlers'
import { isValidSignedAuthEvent } from '../../utils/event'
import { IWebSocketAdapter } from '../../@types/adapters'

const debug = createLogger('default-event-strategy')

export class SignedAuthEventStrategy implements IEventStrategy<Event, Promise<void>> {
  public constructor(
    private readonly webSocket: IWebSocketAdapter,
  ) { }

  // TODO this is how we send out events, we need to do this
  // in the message handler (verify if this is true)
  public async execute(event: Event): Promise<void> {
    debug('received signedAuth event: %o', event)
    const clientChallenge = this.webSocket.getClientChallenge()
    const verified = await isValidSignedAuthEvent(event, clientChallenge)

    if (verified) {
      this.webSocket.setClientToAuthenticated()
    }

    // NOTE: we can add a message here if auth fails
    // this.webSocket.emit(WebSocketAdapterEvent.Message, createCommandResult(event.id, true, 'auth error'))

    // NOTE: we can add a message here if auth succeeds
    // if (verified) {
    //   this.webSocket.emit(WebSocketAdapterEvent.Message, createCommandResult(event.id, true, 'successful auth'))
    // }
  }
}
