import { assocPath, omit } from 'ramda'
import { expect } from 'chai'

import { Event } from '../../../src/@types/event'
import { eventSchema } from '../../../src/schemas/event-schema'
import { EventKinds, EventTags } from '../../../src/constants/base'
import { validateSchema } from '../../../src/utils/validation'

describe('NIP-01', () => {
  let event: Event
  describe('validate event schema', () => {
    beforeEach(() => {
      event = {
        id: 'fa4dd948576fe182f5d0e3120b9df42c83dffa1c884754d5e4d3b0a2f98a01c5',
        pubkey: 'edfa27d49d2af37ee331e1225bb6ed1912c6d999281b36d8018ad99bc3573c29',
        created_at: 1660306803,
        kind: 7,
        tags: [
          [EventTags.Event, 'c58e83bb744e4c29642db7a5c3bd1519516ad5c51f6ba5f90c451d03c1961210', '', 'root'],
          [EventTags.Event, 'd0d78967b734628cec7bdfa2321c71c1f1c48e211b4b54333c3b0e94e7e99166', '', 'reply'],
          [EventTags.Pubkey, 'edfa27d49d2af37ee331e1225bb6ed1912c6d999281b36d8018ad99bc3573c29'],
          [EventTags.Pubkey, '32e1827635450ebb3c5a7d12c1f8e7b2b514439ac10a67eef3d9fd9c5c68e245'],
          [EventTags.Event, '6fed2aae1e4f7d8b535774e4f7061c10e2ff20df1ef047da09462c7937925cd5'],
          [EventTags.Pubkey, '2ef93f01cd2493e04235a6b87b10d3c4a74e2a7eb7c3caf168268f6af73314b5'],
        ],
        content: '',
        sig: '313a9b8cd68267a51da84e292c0937d1f3686c6757c4584f50fcedad2b13fad755e6226924f79880fb5aa9de95c04231a4823981513ac9e7092bad7488282a96',
      }
    })

    it('returns same event if event is valid', () => {
      const result = validateSchema(eventSchema)(event)

      expect(result.error).to.be.undefined
      expect(result.value).to.deep.equal(event)
    })

    it('returns error if unknown key is provided', () => {
      Object.assign(event, { unknown: 1 })

      expect(validateSchema(eventSchema)(event)).to.have.property('error').that.is.not.undefined
    })

    const cases = {
      id: [
        { message: 'must be a string', transform: assocPath(['id'], null) },
        { message: 'must only contain lowercase characters', transform: assocPath(['id'], 'F'.repeat(64)) },
        { message: 'must only contain hexadecimal characters', transform: assocPath(['id'], 'not hex') },
        { message: 'length must be 64 characters long', transform: assocPath(['id'], 'f'.repeat(65)) },
        { message: 'length must be 64 characters long', transform: assocPath(['id'], 'f'.repeat(63)) },
        { message: 'is not allowed to be empty', transform: assocPath(['id'], '') },
        { message: 'is required', transform: omit(['id']) },
      ],
      pubkey: [
        { message: 'must be a string', transform: assocPath(['pubkey'], null) },
        { message: 'must only contain lowercase characters', transform: assocPath(['pubkey'], 'F'.repeat(64)) },
        { message: 'must only contain hexadecimal characters', transform: assocPath(['pubkey'], 'not hex') },
        { message: 'length must be 64 characters long', transform: assocPath(['pubkey'], 'f'.repeat(65)) },
        { message: 'length must be 64 characters long', transform: assocPath(['pubkey'], 'f'.repeat(63)) },
        { message: 'is not allowed to be empty', transform: assocPath(['pubkey'], '') },
        { message: 'is required', transform: omit(['pubkey']) },
      ],
      created_at: [
        { message: 'contains an invalid value', transform: assocPath(['created_at'], 1672295751103) },
        { message: 'must be a number', transform: assocPath(['created_at'], null) },
        { message: 'must be greater than or equal to 0', transform: assocPath(['created_at'], -1) },
        { message: 'must be a multiple of 1', transform: assocPath(['created_at'], Math.PI) },
        { message: 'is required', transform: omit(['created_at']) },
      ],
      kind: [
        { message: 'must be a number', transform: assocPath(['kind'], null) },
        { message: 'must be greater than or equal to 0', transform: assocPath(['kind'], -1) },
        { message: 'must be a multiple of 1', transform: assocPath(['kind'], Math.PI) },
        { message: 'is required', transform: omit(['kind']) },
      ],
      content: [
        { message: 'must be a string', transform: assocPath(['content'], null) },
        { message: 'is required', transform: omit(['content']) },
      ],
      sig: [
        { message: 'must be a string', transform: assocPath(['sig'], null) },
        { message: 'must only contain lowercase characters', transform: assocPath(['sig'], 'F'.repeat(128)) },
        { message: 'must only contain hexadecimal characters', transform: assocPath(['sig'], 'not hex') },
        { message: 'length must be 128 characters long', transform: assocPath(['sig'], 'f'.repeat(129)) },
        { message: 'length must be 128 characters long', transform: assocPath(['sig'], 'f'.repeat(127)) },
        { message: 'is not allowed to be empty', transform: assocPath(['sig'], '') },
        { message: 'is required', transform: omit(['sig']) },
      ],
      tags: [
        { message: 'must be an array', transform: assocPath(['tags'], null) },
        { message: 'is required', transform: omit(['tags']) },
      ],
      tag: [{ message: 'must be an array', transform: assocPath(['tags', 0], null) }],
      identifier: [
        { message: 'must be a string', transform: assocPath(['tags', 0, 0], null) },
        { message: 'is not allowed to be empty', transform: assocPath(['tags', 0, 0], '') },
      ],
      value: [{ message: 'must be a string', transform: assocPath(['tags', 0, 1], null) }],
    }

    for (const prop in cases) {
      describe(prop, () => {
        cases[prop].forEach(({ transform, message }) => {
          it(`${prop} ${message}`, () =>
            expect(validateSchema(eventSchema)(transform(event))).to.have.property('error').that.is.not.undefined)
        })
      })
    }
  })
})

describe('NIP-25', () => {
  const base: Event = {
    id: 'fa4dd948576fe182f5d0e3120b9df42c83dffa1c884754d5e4d3b0a2f98a01c5',
    pubkey: 'edfa27d49d2af37ee331e1225bb6ed1912c6d999281b36d8018ad99bc3573c29',
    created_at: 1660306803,
    kind: EventKinds.REACTION,
    tags: [],
    content: '+',
    sig: '313a9b8cd68267a51da84e292c0937d1f3686c6757c4584f50fcedad2b13fad755e6226924f79880fb5aa9de95c04231a4823981513ac9e7092bad7488282a96',
  }

  it('accepts reaction with e tag', () => {
    const event = { ...base, tags: [[EventTags.Event, 'a'.repeat(64)]] }
    expect(validateSchema(eventSchema)(event).error).to.be.undefined
  })

  it('rejects reaction missing e tag', () => {
    expect(validateSchema(eventSchema)({ ...base, tags: [] }).error).to.not.be.undefined
  })

  it('accepts external content reaction with k and i tags', () => {
    const event = {
      ...base,
      kind: EventKinds.EXTERNAL_CONTENT_REACTION,
      tags: [[EventTags.Kind, 'web'], [EventTags.Index, 'https://example.com']],
    }
    expect(validateSchema(eventSchema)(event).error).to.be.undefined
  })

  it('rejects external content reaction missing k tag', () => {
    const event = {
      ...base,
      kind: EventKinds.EXTERNAL_CONTENT_REACTION,
      tags: [[EventTags.Index, 'https://example.com']],
    }
    expect(validateSchema(eventSchema)(event).error).to.not.be.undefined
  })

  it('rejects external content reaction missing i tag', () => {
    const event = {
      ...base,
      kind: EventKinds.EXTERNAL_CONTENT_REACTION,
      tags: [[EventTags.Kind, 'web']],
    }
    expect(validateSchema(eventSchema)(event).error).to.not.be.undefined
  })
})

describe('NIP-65', () => {
  const relayListBase: Event = {
    id: 'fa4dd948576fe182f5d0e3120b9df42c83dffa1c884754d5e4d3b0a2f98a01c5',
    pubkey: 'edfa27d49d2af37ee331e1225bb6ed1912c6d999281b36d8018ad99bc3573c29',
    created_at: 1660306803,
    kind: EventKinds.RELAY_LIST,
    tags: [],
    content: '',
    sig: '313a9b8cd68267a51da84e292c0937d1f3686c6757c4584f50fcedad2b13fad755e6226924f79880fb5aa9de95c04231a4823981513ac9e7092bad7488282a96',
  }

  it('accepts relay_list event with valid wss relay URL', () => {
    const event = { ...relayListBase, tags: [[EventTags.Relay, 'wss://relay.example.com']] }
    const result = validateSchema(eventSchema)(event)
    expect(result.error).to.be.undefined
  })

  it('accepts relay_list event with valid wss relay URL and read marker', () => {
    const event = { ...relayListBase, tags: [[EventTags.Relay, 'wss://relay.example.com', 'read']] }
    const result = validateSchema(eventSchema)(event)
    expect(result.error).to.be.undefined
  })

  it('accepts relay_list event with valid wss relay URL and write marker', () => {
    const event = { ...relayListBase, tags: [[EventTags.Relay, 'wss://relay.example.com', 'write']] }
    const result = validateSchema(eventSchema)(event)
    expect(result.error).to.be.undefined
  })

  it('accepts relay_list event with no relay tags', () => {
    const event = { ...relayListBase, tags: [] }
    const result = validateSchema(eventSchema)(event)
    expect(result.error).to.be.undefined
  })

  it('rejects relay_list event with invalid relay URL', () => {
    const event = { ...relayListBase, tags: [[EventTags.Relay, 'not-a-url']] }
    const result = validateSchema(eventSchema)(event)
    expect(result.error).to.not.be.undefined
  })

  it('rejects relay_list event with empty relay URL', () => {
    const event = { ...relayListBase, tags: [[EventTags.Relay, '']] }
    const result = validateSchema(eventSchema)(event)
    expect(result.error).to.not.be.undefined
  })

  it('does not validate relay URL on non-relay_list events with r tags', () => {
    const event = { ...relayListBase, kind: EventKinds.TEXT_NOTE, tags: [[EventTags.Relay, 'not-a-url']] }
    const result = validateSchema(eventSchema)(event)
    expect(result.error).to.be.undefined
  })
})

describe('NIP-12', () => {
  const geohashBase: Event = {
    id: 'fa4dd948576fe182f5d0e3120b9df42c83dffa1c884754d5e4d3b0a2f98a01c5',
    pubkey: 'edfa27d49d2af37ee331e1225bb6ed1912c6d999281b36d8018ad99bc3573c29',
    created_at: 1660306803,
    kind: EventKinds.TEXT_NOTE,
    tags: [],
    content: '',
    sig: '313a9b8cd68267a51da84e292c0937d1f3686c6757c4584f50fcedad2b13fad755e6226924f79880fb5aa9de95c04231a4823981513ac9e7092bad7488282a96',
  }

  it('accepts event with valid base32 geohash tag', () => {
    const event = { ...geohashBase, tags: [[EventTags.Geohash, 'u4pruydqqvj']] }
    const result = validateSchema(eventSchema)(event)
    expect(result.error).to.be.undefined
  })

  it('rejects event with non-base32 geohash characters', () => {
    const event = { ...geohashBase, tags: [[EventTags.Geohash, 'u4pruyda']] }
    const result = validateSchema(eventSchema)(event)
    expect(result.error).to.not.be.undefined
  })

  it('rejects event with empty geohash', () => {
    const event = { ...geohashBase, tags: [[EventTags.Geohash, '']] }
    const result = validateSchema(eventSchema)(event)
    expect(result.error).to.not.be.undefined
  })

  it('rejects event with uppercase geohash', () => {
    const event = { ...geohashBase, tags: [[EventTags.Geohash, 'U4PRUYDQQVJ']] }
    const result = validateSchema(eventSchema)(event)
    expect(result.error).to.not.be.undefined
  })
})

describe('NIP-14', () => {
  it('accepts subject tag on text note events', () => {
    const event: Event = {
      id: 'fa4dd948576fe182f5d0e3120b9df42c83dffa1c884754d5e4d3b0a2f98a01c5',
      pubkey: 'edfa27d49d2af37ee331e1225bb6ed1912c6d999281b36d8018ad99bc3573c29',
      created_at: 1660306803,
      kind: 1,
      tags: [[EventTags.Subject, 'SoB weekly update']],
      content: 'testing subject tag',
      sig: '313a9b8cd68267a51da84e292c0937d1f3686c6757c4584f50fcedad2b13fad755e6226924f79880fb5aa9de95c04231a4823981513ac9e7092bad7488282a96',
    }

    const result = validateSchema(eventSchema)(event)

    expect(result.error).to.be.undefined
    expect(result.value).to.deep.equal(event)
  })
})
