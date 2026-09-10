import { createEventCommandResult } from '../../telemetry/event-metrics'
import { createLogger } from '../../factories/logger-factory'
import { Event } from '../../@types/event'
import { IEventStrategy } from '../../@types/message-handlers'
import { IWebSocketAdapter } from '../../@types/adapters'
import { WebSocketAdapterEvent } from '../../constants/adapter'

const logger = createLogger('invite-request-event-strategy')

// NIP-43 kind 28935 travels relay -> client only: a client asks for an invite with
// a REQ, and the relay answers with an event signed by the pubkey in `self`. A
// client-published 28935 is therefore always invalid.
//
// Rejecting it explicitly matters. 28935 falls in the ephemeral range, so without
// this it reaches EphemeralEventStrategy and gets broadcast to every subscriber —
// and the clients subscribed to kind 28935 are exactly the ones waiting for an
// invite. Anyone could inject a forged claim tag into that subscription. Spec
// compliant clients discard it by checking the pubkey against `self`, but the
// relay should not be relaying forgeries in the first place.
export class InviteRequestEventStrategy implements IEventStrategy<Event, Promise<void>> {
  public constructor(private readonly webSocket: IWebSocketAdapter) {}

  public async execute(event: Event): Promise<void> {
    logger('rejecting client-published invite request from %s', event.pubkey)

    this.webSocket.emit(
      WebSocketAdapterEvent.Message,
      createEventCommandResult(
        event.id,
        false,
        'invalid: kind 28935 is issued by the relay, request one with a REQ for kind 28935',
      ),
    )
  }
}
