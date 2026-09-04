import { ICacheAdapter, IWebSocketAdapter } from '../@types/adapters'
import { IDvmJobRepository, IEventRepository, IInviteCodeRepository, IUserRepository } from '../@types/repositories'
import {
  isContactListEvent,
  isDeleteEvent,
  isDvmJobRequestEvent,
  isEphemeralEvent,
  isGiftWrapEvent,
  isMarmotGroupEvent,
  isOpenTimestampsEvent,
  isParameterizedReplaceableEvent,
  isReplaceableEvent,
  isRequestToVanishEvent,
} from '../utils/event'
import { isNip43JoinRequest, isNip43LeaveRequest } from '../utils/nip43'
import { isRelayListEvent } from '../utils/nip65'
import { ContactListEventStrategy } from '../handlers/event-strategies/contact-list-event-strategy'
import { DefaultEventStrategy } from '../handlers/event-strategies/default-event-strategy'
import { DeleteEventStrategy } from '../handlers/event-strategies/delete-event-strategy'
import { DvmJobRequestEventStrategy } from '../handlers/event-strategies/dvm-job-request-event-strategy'
import { EphemeralEventStrategy } from '../handlers/event-strategies/ephemeral-event-strategy'
import { Event } from '../@types/event'
import { Factory } from '../@types/base'
import { GiftWrapEventStrategy } from '../handlers/event-strategies/gift-wrap-event-strategy'
import { GroupEventStrategy } from '../handlers/event-strategies/group-event-strategy'
import { IEventStrategy } from '../@types/message-handlers'
import { JoinRequestEventStrategy } from '../handlers/event-strategies/join-request-event-strategy'
import { LeaveRequestEventStrategy } from '../handlers/event-strategies/leave-request-event-strategy'
import { ParameterizedReplaceableEventStrategy } from '../handlers/event-strategies/parameterized-replaceable-event-strategy'
import { ReplaceableEventStrategy } from '../handlers/event-strategies/replaceable-event-strategy'
import { Settings } from '../@types/settings'
import { TimestampEventStrategy } from '../handlers/event-strategies/timestamp-event-strategy'
import { VanishEventStrategy } from '../handlers/event-strategies/vanish-event-strategy'
import { wotGraphServiceFactory } from './wot-graph-service-factory'

export const eventStrategyFactory =
  (
    eventRepository: IEventRepository,
    userRepository: IUserRepository,
    inviteCodeRepository: IInviteCodeRepository,
    dvmJobRepository: IDvmJobRepository,
    cache: ICacheAdapter,
    settings: () => Settings,
  ): Factory<IEventStrategy<Event, Promise<void>>, [Event, IWebSocketAdapter]> =>
  ([event, adapter]: [Event, IWebSocketAdapter]) => {
    if (isRequestToVanishEvent(event)) {
      return new VanishEventStrategy(adapter, eventRepository, userRepository)
    } else if (isGiftWrapEvent(event)) {
      return new GiftWrapEventStrategy(adapter, eventRepository)
    } else if (isMarmotGroupEvent(event)) {
      return new GroupEventStrategy(adapter, eventRepository)
    } else if (isOpenTimestampsEvent(event)) {
      return new TimestampEventStrategy(adapter, eventRepository)
      // NIP-02: contact lists are replaceable (handled below), but need the
      // extra wot-graph side effect, so they're intercepted before the
      // generic replaceable-event branch.
    } else if (isContactListEvent(event)) {
      return new ContactListEventStrategy(
        adapter,
        eventRepository,
        wotGraphServiceFactory(cache, eventRepository, settings),
      )
    } else if (isRelayListEvent(event) || isReplaceableEvent(event)) {
      return new ReplaceableEventStrategy(adapter, eventRepository)
      // NIP-43: Join/Leave requests MUST be checked before the generic ephemeral
      // handler, because kinds 28934/28936 fall in the ephemeral range (20000-29999).
    } else if (isNip43JoinRequest(event)) {
      return new JoinRequestEventStrategy(adapter, inviteCodeRepository, userRepository, cache, settings)
    } else if (isNip43LeaveRequest(event)) {
      return new LeaveRequestEventStrategy(adapter, userRepository, cache, settings)
      // NIP-90: DVM job requests (kind 5000-5999) checked early, same reasoning
      // as the NIP-43 checks above — kept explicit rather than relying on it
      // falling through to DefaultEventStrategy.
    } else if (isDvmJobRequestEvent(event)) {
      return new DvmJobRequestEventStrategy(adapter, eventRepository, dvmJobRepository)
    } else if (isEphemeralEvent(event)) {
      return new EphemeralEventStrategy(adapter)
    } else if (isDeleteEvent(event)) {
      return new DeleteEventStrategy(adapter, eventRepository)
    } else if (isParameterizedReplaceableEvent(event)) {
      return new ParameterizedReplaceableEventStrategy(adapter, eventRepository)
    }

    return new DefaultEventStrategy(adapter, eventRepository)
  }
