import { expect } from 'chai'
import { Event } from '../../../src/@types/event'
import { isRelayListEvent, parseRelayList } from '../../../src/utils/nip65'

const baseEvent = (): Partial<Event> => ({
  kind: 10002,
  tags: [],
  content: '',
})

describe('NIP-65', () => {
  describe('isRelayListEvent', () => {
    it('returns true for kind 10002', () => {
      expect(isRelayListEvent({ ...baseEvent(), kind: 10002 } as Event)).to.equal(true)
    })

    it('returns false for kind 0 (set_metadata)', () => {
      expect(isRelayListEvent({ ...baseEvent(), kind: 0 } as Event)).to.equal(false)
    })

    it('returns false for kind 3 (contact_list)', () => {
      expect(isRelayListEvent({ ...baseEvent(), kind: 3 } as Event)).to.equal(false)
    })

    it('returns false for kind 1 (text_note)', () => {
      expect(isRelayListEvent({ ...baseEvent(), kind: 1 } as Event)).to.equal(false)
    })
  })

  describe('parseRelayList', () => {
    it('returns empty array when tags is empty', () => {
      const event = { ...baseEvent(), tags: [] } as unknown as Event
      expect(parseRelayList(event)).to.deep.equal([])
    })

    it('parses a relay tag with no marker as read+write', () => {
      const event = { ...baseEvent(), tags: [['r', 'wss://relay.example.com']] } as unknown as Event
      expect(parseRelayList(event)).to.deep.equal([{ url: 'wss://relay.example.com', marker: undefined }])
    })

    it('parses a relay tag with read marker', () => {
      const event = { ...baseEvent(), tags: [['r', 'wss://relay.example.com', 'read']] } as unknown as Event
      expect(parseRelayList(event)).to.deep.equal([{ url: 'wss://relay.example.com', marker: 'read' }])
    })

    it('parses a relay tag with write marker', () => {
      const event = { ...baseEvent(), tags: [['r', 'wss://relay.example.com', 'write']] } as unknown as Event
      expect(parseRelayList(event)).to.deep.equal([{ url: 'wss://relay.example.com', marker: 'write' }])
    })

    it('sets marker to undefined when tag[2] is an unrecognized string', () => {
      const event = { ...baseEvent(), tags: [['r', 'wss://relay.example.com', 'both']] } as unknown as Event
      expect(parseRelayList(event)).to.deep.equal([{ url: 'wss://relay.example.com', marker: undefined }])
    })

    it('ignores tags where tag[0] is not "r"', () => {
      const event = {
        ...baseEvent(),
        tags: [
          ['p', 'somepubkey'],
          ['e', 'someeventid'],
        ],
      } as unknown as Event
      expect(parseRelayList(event)).to.deep.equal([])
    })

    it('ignores tags shorter than 2 elements', () => {
      const event = { ...baseEvent(), tags: [['r']] } as unknown as Event
      expect(parseRelayList(event)).to.deep.equal([])
    })

    it('parses a mixed list correctly', () => {
      const event = {
        ...baseEvent(),
        tags: [
          ['r', 'wss://alice.relay.com'],
          ['r', 'wss://bob.relay.com', 'write'],
          ['r', 'wss://carol.relay.com', 'read'],
          ['p', 'somepubkey'],
        ],
      } as unknown as Event

      expect(parseRelayList(event)).to.deep.equal([
        { url: 'wss://alice.relay.com', marker: undefined },
        { url: 'wss://bob.relay.com', marker: 'write' },
        { url: 'wss://carol.relay.com', marker: 'read' },
      ])
    })
  })
})
