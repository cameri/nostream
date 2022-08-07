import { expect } from 'chai'
import { Event, EventKinds, CanonicalEvent } from '../../src/types/event'
import { serializeEvent } from '../../src/event'

describe('serializeEvent', () => {
  it('returns serialized event given a Nostr event', () => {
    const event: Partial<Event> = {
      pubkey: 'pubkey',
      created_at: 1000,
      kind: EventKinds.TEXT_NODE,
      tags: [['tag name', 'tag content']],
      content: 'content',
    }

    const expected: CanonicalEvent = [
      0,
      'pubkey',
      1000,
      EventKinds.TEXT_NODE,
      [['tag name', 'tag content']],
      'content',
    ]

    expect(serializeEvent(event)).to.eqls(expected)
  })
})
