import { createCommandResult } from '../../utils/messages'
import { createLogger } from '../../factories/logger-factory'
import { Event } from '../../@types/event'
import { EventTags } from '../../constants/base'
import { IEventRepository } from '../../@types/repositories'
import { IEventStrategy } from '../../@types/message-handlers'
import { IWebSocketAdapter } from '../../@types/adapters'
import { validateOtsProof } from '../../utils/nip03'
import { WebSocketAdapterEvent } from '../../constants/adapter'

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

    const targetEventId = eTags[0][1]
    if (!/^[0-9a-f]{64}$/i.test(targetEventId)) {
      return 'opentimestamps e tag must contain a 32-byte lowercase hex event id'
    }

    // If a `k` tag is present it should parse as a non-negative integer. We
    // don't enforce it against the actual target event's kind (the relay may
    // not have seen that event), but we do require it to be well-formed so
    // downstream consumers can trust the field.
    const kTag = event.tags.find((tag) => Array.isArray(tag) && tag.length >= 2 && tag[0] === EventTags.Kind)
    if (kTag) {
      const parsed = Number(kTag[1])
      if (!Number.isInteger(parsed) || parsed < 0 || !/^\d+$/.test(String(kTag[1]))) {
        return 'opentimestamps k tag must be a non-negative integer kind'
      }
    }

    return validateOtsProof(event.content, targetEventId.toLowerCase())
  }
}
