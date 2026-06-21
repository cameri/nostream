import { expect } from 'chai'

import { IEventRepository, IUserRepository } from '../../../src/@types/repositories'
import { DefaultEventStrategy } from '../../../src/handlers/event-strategies/default-event-strategy'
import { DeleteEventStrategy } from '../../../src/handlers/event-strategies/delete-event-strategy'
import { EphemeralEventStrategy } from '../../../src/handlers/event-strategies/ephemeral-event-strategy'
import { Event } from '../../../src/@types/event'
import { EventKinds } from '../../../src/constants/base'
import { eventStrategyFactory } from '../../../src/factories/event-strategy-factory'
import { Factory } from '../../../src/@types/base'
import { GiftWrapEventStrategy } from '../../../src/handlers/event-strategies/gift-wrap-event-strategy'
import { GroupEventStrategy } from '../../../src/handlers/event-strategies/group-event-strategy'
import { IEventStrategy } from '../../../src/@types/message-handlers'
import { IWebSocketAdapter } from '../../../src/@types/adapters'
import { ParameterizedReplaceableEventStrategy } from '../../../src/handlers/event-strategies/parameterized-replaceable-event-strategy'
import { ReplaceableEventStrategy } from '../../../src/handlers/event-strategies/replaceable-event-strategy'
import { TimestampEventStrategy } from '../../../src/handlers/event-strategies/timestamp-event-strategy'
import { VanishEventStrategy } from '../../../src/handlers/event-strategies/vanish-event-strategy'

describe('eventStrategyFactory', () => {
  let eventRepository: IEventRepository
  let userRepository: IUserRepository
  let event: Event
  let adapter: IWebSocketAdapter
  let factory: Factory<IEventStrategy<Event, Promise<void>>, [Event, IWebSocketAdapter]>

  beforeEach(() => {
    eventRepository = {} as any
    userRepository = {} as any
    event = {} as any
    adapter = {} as any

    factory = eventStrategyFactory(eventRepository, userRepository)
  })

  it('returns ReplaceableEvent given a set_metadata event', () => {
    event.kind = EventKinds.SET_METADATA
    expect(factory([event, adapter])).to.be.an.instanceOf(ReplaceableEventStrategy)
  })

  it('returns ReplaceableEvent given a contact_list event', () => {
    event.kind = EventKinds.CONTACT_LIST
    expect(factory([event, adapter])).to.be.an.instanceOf(ReplaceableEventStrategy)
  })

  it('returns ReplaceableEvent given a replaceable event', () => {
    event.kind = EventKinds.REPLACEABLE_FIRST
    expect(factory([event, adapter])).to.be.an.instanceOf(ReplaceableEventStrategy)
  })

  it('returns ReplaceableEventStrategy given a relay_list event (NIP-65)', () => {
    event.kind = EventKinds.RELAY_LIST
    expect(factory([event, adapter])).to.be.an.instanceOf(ReplaceableEventStrategy)
  })

  it('returns EphemeralEventStrategy given an ephemeral event', () => {
    event.kind = EventKinds.EPHEMERAL_FIRST
    expect(factory([event, adapter])).to.be.an.instanceOf(EphemeralEventStrategy)
  })

  it('returns DeleteEventStrategy given a delete event', () => {
    event.kind = EventKinds.DELETE
    expect(factory([event, adapter])).to.be.an.instanceOf(DeleteEventStrategy)
  })

  it('returns VanishEventStrategy given a request to vanish event', () => {
    event.kind = EventKinds.REQUEST_TO_VANISH
    expect(factory([event, adapter])).to.be.an.instanceOf(VanishEventStrategy)
  })

  it('returns GiftWrapEventStrategy given a gift wrap event', () => {
    event.kind = EventKinds.GIFT_WRAP
    expect(factory([event, adapter])).to.be.an.instanceOf(GiftWrapEventStrategy)
  })

  it('returns GroupEventStrategy given a Marmot group event (kind 445)', () => {
    event.kind = EventKinds.MARMOT_GROUP_EVENT
    expect(factory([event, adapter])).to.be.an.instanceOf(GroupEventStrategy)
  })

  it('returns ParameterizedReplaceableEventStrategy given a Marmot KeyPackage event (kind 30443)', () => {
    event.kind = EventKinds.MARMOT_KEY_PACKAGE
    expect(factory([event, adapter])).to.be.an.instanceOf(ParameterizedReplaceableEventStrategy)
  })

  it('returns ReplaceableEventStrategy given a Marmot KeyPackage relay list (kind 10051)', () => {
    event.kind = EventKinds.MARMOT_KEY_PACKAGE_RELAY_LIST
    expect(factory([event, adapter])).to.be.an.instanceOf(ReplaceableEventStrategy)
  })

  it('returns DefaultEventStrategy given a legacy Marmot KeyPackage (kind 443)', () => {
    event.kind = EventKinds.MARMOT_KEY_PACKAGE_LEGACY
    expect(factory([event, adapter])).to.be.an.instanceOf(DefaultEventStrategy)
  })

  it('returns TimestampEventStrategy given an opentimestamps (NIP-03) event', () => {
    event.kind = EventKinds.OPEN_TIMESTAMPS
    expect(factory([event, adapter])).to.be.an.instanceOf(TimestampEventStrategy)
  })

  it('returns ParameterizedReplaceableEventStrategy given a delete event', () => {
    event.kind = EventKinds.PARAMETERIZED_REPLACEABLE_FIRST
    expect(factory([event, adapter])).to.be.an.instanceOf(ParameterizedReplaceableEventStrategy)
  })

  it('returns DefaultEventStrategy given a text_note event', () => {
    event.kind = EventKinds.TEXT_NOTE
    expect(factory([event, adapter])).to.be.an.instanceOf(DefaultEventStrategy)
  })

  it('returns DefaultEventStrategy given a reaction event (NIP-25)', () => {
    event.kind = EventKinds.REACTION
    expect(factory([event, adapter])).to.be.an.instanceOf(DefaultEventStrategy)
  })

  it('returns DefaultEventStrategy given an external content reaction event (NIP-25)', () => {
    event.kind = EventKinds.EXTERNAL_CONTENT_REACTION
    expect(factory([event, adapter])).to.be.an.instanceOf(DefaultEventStrategy)
  })
})
