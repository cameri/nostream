import { andThen, pipe } from 'ramda'

import { Event, UnidentifiedEvent } from '../@types/event'
import { EventKinds, EventTags } from '../constants/base'
import { getPublicKey, getRelayPrivateKey, identifyEvent, signEvent } from './event'
import { IEventRepository, IUserRepository } from '../@types/repositories'
import { IWebSocketAdapter } from '../@types/adapters'
import { isRelaySelfConsistent } from './nip43'
import { Pubkey, Tag } from '../@types/base'
import { createLogger } from '../factories/logger-factory'
import { Settings } from '../@types/settings'
import { WebSocketAdapterEvent } from '../constants/adapter'

const logger = createLogger('nip43-membership')

// A list this long is already a very large event to deliver to every subscriber, so a relay with more members
// than this publishes the first ones. NIP-43 says clients must not treat the list as complete anyway.
export const MAX_MEMBERSHIP_LIST_ENTRIES = 10_000

/**
 * The NIP-43 membership list (kind 13534): a replaceable event signed by the relay's own key, with the NIP-70
 * `-` tag and one `member` tag per admitted pubkey.
 */
export const buildMembershipListEvent = async (
  relayPrivkey: string,
  relayPubkey: string,
  members: Pubkey[],
  createdAt: number = Math.floor(Date.now() / 1000),
): Promise<Event> => {
  const tags: Tag[] = [
    // NIP-70: the tag carries no value, which Tag (which requires an index 1) cannot express.
    [EventTags.Protected] as unknown as Tag,
    ...members.map((member): Tag => [EventTags.Member, member]),
  ]

  const unidentifiedEvent: UnidentifiedEvent = {
    pubkey: relayPubkey,
    kind: EventKinds.NIP43_MEMBERSHIP_LIST,
    created_at: createdAt,
    content: '',
    tags,
  }

  return pipe(identifyEvent, andThen(signEvent(relayPrivkey)))(unidentifiedEvent)
}

// Refreshes are queued so that two joins handled at the same moment do not publish out of order. The queue is
// per process: a second worker can still publish at the same time, which the list's "not authoritative"
// status allows, and the next join or leave corrects it.
let queue: Promise<void> = Promise.resolve()

export class MembershipListPublisher {
  public constructor(
    private readonly settings: () => Settings,
    private readonly userRepository: IUserRepository,
    private readonly eventRepository: IEventRepository,
    private readonly webSocket: IWebSocketAdapter,
  ) {}

  /** Publishes the current membership list when `nip43.publishMembershipList` is on, and does nothing otherwise. */
  public refresh(): Promise<void> {
    const run = queue.then(() => this.publish())
    queue = run.catch(() => undefined)

    return run
  }

  private async publish(): Promise<void> {
    const settings = this.settings()

    if (settings.nip43?.enabled !== true || settings.nip43.publishMembershipList !== true) {
      return
    }

    // NIP-43 requires the list to be signed by the pubkey advertised as `self`; the relay signs with a key derived
    // from SECRET, so a hand-edited `info.self` that differs would make the list unverifiable.
    let selfConsistent: boolean | undefined
    try {
      selfConsistent = isRelaySelfConsistent(settings)
    } catch (error) {
      logger('info.self is not a valid pubkey, not publishing the membership list: %o', error)
      return
    }

    if (selfConsistent === false) {
      logger('info.self does not match the relay signing pubkey, not publishing the membership list')
      return
    }

    const relayPrivkey = getRelayPrivateKey(settings.info?.relay_url)
    const relayPubkey = getPublicKey(relayPrivkey)

    // One more than the cap tells us whether the list had to be cut.
    const members = await this.userRepository.findAdmittedPubkeys(MAX_MEMBERSHIP_LIST_ENTRIES + 1)
    if (members.length > MAX_MEMBERSHIP_LIST_ENTRIES) {
      logger('more than %d members, the membership list is cut to the first ones', MAX_MEMBERSHIP_LIST_ENTRIES)
      members.length = MAX_MEMBERSHIP_LIST_ENTRIES
    }

    // A replaceable event is only replaced by a later created_at (or an equal one with a lower id), so a refresh in
    // the same second as the last one would otherwise keep either list at random.
    const [stored] = await this.eventRepository.findStoredReplaceable(relayPubkey, EventKinds.NIP43_MEMBERSHIP_LIST)
    const now = Math.floor(Date.now() / 1000)
    const createdAt = stored ? Math.max(now, stored.event_created_at + 1) : now

    const event = await buildMembershipListEvent(relayPrivkey, relayPubkey, members, createdAt)

    const count = await this.eventRepository.upsert(event)
    if (count) {
      this.webSocket.emit(WebSocketAdapterEvent.Broadcast, event)
    }

    logger('published a membership list with %d members', members.length)
  }
}
