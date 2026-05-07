import { expect } from 'chai'

import {
  createCommandResult,
  createEndOfStoredEventsNoticeMessage,
  createNoticeMessage,
  createOutgoingEventMessage,
  createRelayedEventMessage,
  createSubscriptionMessage,
} from '../../../src/utils/messages'
import { Event, RelayedEvent } from '../../../src/@types/event'
import { MessageType } from '../../../src/@types/messages'

describe('createNotice', () => {
  it('returns a notice message', () => {
    expect(createNoticeMessage('some notice')).to.deep.equal([MessageType.NOTICE, 'some notice'])
  })
})

describe('createOutgoingEventMessage', () => {
  it('returns an event message', () => {
    const event: Event = {
      id: 'some id',
    } as any
    expect(createOutgoingEventMessage('subscriptionId', event)).to.deep.equal([
      MessageType.EVENT,
      'subscriptionId',
      event,
    ])
  })
})

describe('createEndOfStoredEventsNoticeMessage', () => {
  it('returns a EOSE message', () => {
    expect(createEndOfStoredEventsNoticeMessage('subscriptionId')).to.deep.equal([MessageType.EOSE, 'subscriptionId'])
  })
})

describe('createCommandResult', () => {
  it('returns a command result message', () => {
    expect(createCommandResult('event-id', true, 'accepted')).to.deep.equal([
      MessageType.OK,
      'event-id',
      true,
      'accepted',
    ])
  })

  it('returns an OK message with success=true and a reason', () => {
    const eventId = 'b1601d26958e6508b7b9df0af609c652346c09392b6534d93aead9819a51b4ef'
    expect(createCommandResult(eventId, true, '')).to.deep.equal([MessageType.OK, eventId, true, ''])
  })

  it('returns an OK message with success=false and a rejection reason', () => {
    const eventId = 'b1601d26958e6508b7b9df0af609c652346c09392b6534d93aead9819a51b4ef'
    expect(createCommandResult(eventId, false, 'blocked: content not allowed')).to.deep.equal([
      MessageType.OK,
      eventId,
      false,
      'blocked: content not allowed',
    ])
  })
})

describe('createSubscriptionMessage', () => {
  it('returns a REQ message with a single filter', () => {
    const result = createSubscriptionMessage('sub1', [{ kinds: [1] }])
    expect(result[0]).to.equal(MessageType.REQ)
    expect(result[1]).to.equal('sub1')
    expect(result[2]).to.deep.equal({ kinds: [1] })
  })

  it('returns a REQ message with multiple filters', () => {
    const filters = [{ kinds: [1] }, { kinds: [0], authors: ['somepubkey'] }]
    const result = createSubscriptionMessage('sub2', filters)
    expect(result[0]).to.equal(MessageType.REQ)
    expect(result[1]).to.equal('sub2')
    expect(result[2]).to.deep.equal(filters[0])
    expect(result[3]).to.deep.equal(filters[1])
  })

  it('returns a subscription message with filters', () => {
    const filters = [{ authors: ['author-1'], kinds: [1], '#p': ['recipient-1'] }]

    expect(createSubscriptionMessage('subscriptionId', filters)).to.deep.equal([
      MessageType.REQ,
      'subscriptionId',
      ...filters,
    ])
  })
})

describe('createRelayedEventMessage', () => {
  let event: RelayedEvent

  beforeEach(() => {
    event = {
      id: 'b1601d26958e6508b7b9df0af609c652346c09392b6534d93aead9819a51b4ef',
      kind: 1,
      pubkey: '22e804d26ed16b68db5259e78449e96dab5d464c8f470bda3eb1a70467f2c793',
      created_at: 1648339664,
      tags: [],
      content: 'hello',
      sig: 'abc123',
    } as any
  })

  it('returns an EVENT message without secret when secret is missing', () => {
    expect(createRelayedEventMessage(event)).to.deep.equal([MessageType.EVENT, event])
  })

  it('returns an EVENT message with secret when provided', () => {
    expect(createRelayedEventMessage(event, 'shared-secret')).to.deep.equal([
      MessageType.EVENT,
      event,
      'shared-secret',
    ])
  })
})
