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
    expect(createOutgoingEventMessage('subscriptionId', event)).to.deep.equal([MessageType.EVENT, 'subscriptionId', event])
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
})

describe('createSubscriptionMessage', () => {
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
  const event: RelayedEvent = {
    id: 'event-id',
  } as any

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

