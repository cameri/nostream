import { IWebSocketAdapter } from '../../@types/adapters'
import { Event } from '../../@types/event'
import { IEventStrategy } from '../../@types/message-handlers'
import { IEventRepository } from '../../@types/repositories'
import { WebSocketAdapterEvent } from '../../constants/adapter'
import { EventTags } from '../../constants/base'
import { createLogger } from '../../factories/logger-factory'
import { createCommandResult } from '../../utils/messages'
import { validateOtsProof } from '../../utils/nip03'

const debug = createLogger('timestamp-event-strategy')

/**
 * NIP-03 — OpenTimestamps attestations (kind 1040).
 *
 * A well-formed NIP-03 event must:
 *   - carry exactly one `e` tag that references the event being attested to,
 *   - optionally carry a `k` tag with the target event's kind (integer),
 *   - have `content` equal to the base64-encoded body of a `.ots` file whose
 *     SHA-256 file digest equals the referenced event id and which contains
 *     at least one Bitcoin block-header attestation.
 *
 * Unlike most kinds, we reject structurally invalid NIP-03 events before
 * persisting them: storing a timestamp that doesn't actually commit to the
 * event it names is actively misleading to clients, so a relay that accepts
 * them is worse than useless.
 */
export class TimestampEventStrategy implements IEventStrategy<Event, Promise<void>> {
  public constructor(
    private readonly webSocket: IWebSocketAdapter,
    private readonly eventRepository: IEventRepository,
  ) {}

  public async execute(event: Event): Promise<void> {
    debug('received opentimestamps event: %o', event)

    const reason = this.validate(event)
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

  private validate(event: Event): string | undefined {
    const eTags = event.tags.filter((tag) => Array.isArray(tag) && tag.length >= 2 && tag[0] === EventTags.Event)

    if (eTags.length === 0) {
      return 'opentimestamps event (kind 1040) must have an e tag referencing the attested event'
    }

    if (eTags.length > 1) {
      // NIP-03 defines a single target per attestation. Multiple `e` tags
      // are ambiguous: the proof can only commit to one digest, so accepting
      // more than one `e` tag would let a publisher mis-attribute a valid
      // proof to unrelated events.
      return 'opentimestamps event (kind 1040) must reference exactly one event'
    }

    // NIP-01 defines event ids as 32-byte lowercase hex. We enforce that
    // here so consumers can rely on a canonical form and so
    // `validateOtsProof` sees bytes that already match by literal equality.
    const targetEventId = eTags[0][1]
    if (!/^[0-9a-f]{64}$/.test(targetEventId)) {
      return 'opentimestamps e tag must contain a 32-byte lowercase hex event id'
    }

    // NIP-03's `k` tag is optional and effectively singular: it carries the
    // kind of the referenced event. Multiple `k` tags would be ambiguous —
    // and accepting an event where only the first `k` is well-formed would
    // let malformed trailing `k` tags sneak through. Reject multiples and
    // validate the lone value as a non-negative integer.
    const kTags = event.tags.filter((tag) => Array.isArray(tag) && tag.length >= 2 && tag[0] === EventTags.Kind)
    if (kTags.length > 1) {
      return 'opentimestamps event (kind 1040) must have at most one k tag'
    }
    if (kTags.length === 1) {
      const raw = String(kTags[0][1])
      if (!/^\d+$/.test(raw) || !Number.isInteger(Number(raw)) || Number(raw) < 0) {
        return 'opentimestamps k tag must be a non-negative integer kind'
      }
    }

    return validateOtsProof(event.content, targetEventId)
  }
}
