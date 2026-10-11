import { expect } from 'chai'

import {
  PACKED_EVENT_HEADER_SIZE,
  PackedEventView,
  serializePackedEvent,
  toPackedEventFields,
} from '../../../src/utils/strfry'
import { Event } from '../../../src/@types/event'

const ID = Buffer.alloc(32, 0x11)
const PUBKEY = Buffer.alloc(32, 0x22)
const E_TAG = 'ab'.repeat(32)
const P_TAG = 'cd'.repeat(32)

const u64 = (value: bigint): Buffer => {
  const buffer = Buffer.alloc(8)
  buffer.writeBigUInt64LE(value)
  return buffer
}

const tag = (name: string, value: Buffer | string): Buffer => {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value)
  return Buffer.concat([Buffer.from([name.charCodeAt(0), bytes.length]), bytes])
}

const record = (createdAt: bigint, kind: bigint, expiration: bigint, ...tags: Buffer[]): Buffer =>
  Buffer.concat([ID, PUBKEY, u64(createdAt), u64(kind), u64(expiration), ...tags])

// Loose type so tests can use kinds and tags that Event doesn't allow.
type EventOverrides = Partial<Record<keyof Event, unknown>>

const event = (overrides: EventOverrides = {}): Event =>
  ({
    id: ID.toString('hex'),
    pubkey: PUBKEY.toString('hex'),
    created_at: 1700000000,
    kind: 1,
    tags: [],
    content: '',
    sig: '00'.repeat(64),
    ...overrides,
  }) as Event

const packedTags = (overrides: EventOverrides) =>
  toPackedEventFields(event(overrides)).tags.map(({ name, value }) => [name, value.toString()])

describe('strfry packed events', () => {
  describe('PackedEventView', () => {
    it('reads the header fields', () => {
      const view = new PackedEventView(record(1700000000n, 30023n, 1800000000n))

      expect(view.id.equals(ID)).to.equal(true)
      expect(view.pubkey.equals(PUBKEY)).to.equal(true)
      expect(view.createdAt).to.equal(1700000000)
      expect(view.kind).to.equal(30023)
      expect(view.expiration).to.equal(1800000000)
    })

    it('reads values that do not fit in 32 bits', () => {
      const view = new PackedEventView(record(0x1_0000_0005n, 0x100_0000_0000n, 0x1f_ffff_ffff_ffffn))

      expect(view.createdAt).to.equal(0x1_0000_0005)
      expect(view.kind).to.equal(0x100_0000_0000)
      expect(view.expiration).to.equal(Number.MAX_SAFE_INTEGER)
    })

    it('reads tags in order, including empty and binary values', () => {
      const binary = Buffer.from(E_TAG, 'hex')
      const long = Buffer.alloc(255, 0x61)
      const view = new PackedEventView(
        record(1n, 1n, 0n, tag('e', binary), tag('t', 'nostr'), tag('d', ''), tag('r', long)),
      )

      expect(view.tags()).to.deep.equal([
        { name: 'e', value: binary },
        { name: 't', value: Buffer.from('nostr') },
        { name: 'd', value: Buffer.alloc(0) },
        { name: 'r', value: long },
      ])
    })

    it('returns no tags for a record without any', () => {
      expect(new PackedEventView(record(1n, 1n, 0n)).tags()).to.deep.equal([])
    })

    it('rejects a record shorter than the header', () => {
      expect(() => new PackedEventView(Buffer.alloc(PACKED_EVENT_HEADER_SIZE - 1))).to.throw(
        'Packed event is 87 bytes, expected at least 88',
      )
    })

    it('rejects a record that ends inside a tag header', () => {
      const view = new PackedEventView(Buffer.concat([record(1n, 1n, 0n), Buffer.from([0x74])]))

      expect(() => view.tags()).to.throw('Packed event ends inside a tag header at byte 88')
    })

    it('rejects a tag value that runs past the end of the record', () => {
      const view = new PackedEventView(Buffer.concat([record(1n, 1n, 0n), Buffer.from([0x74, 5, 0x61, 0x62])]))

      expect(() => view.tags()).to.throw('Packed event tag at byte 88 runs past the end of the record')
    })
  })

  describe('toPackedEventFields', () => {
    it('keeps single-letter tags in order and drops longer names', () => {
      expect(
        packedTags({
          tags: [
            ['t', 'nostr'],
            ['subject', 'hi'],
            ['r', 'wss://relay.example.com'],
            ['client', 'nostream'],
          ],
        }),
      ).to.deep.equal([
        ['t', 'nostr'],
        ['r', 'wss://relay.example.com'],
      ])
    })

    it('packs e and p values as 32 raw bytes', () => {
      const { tags } = toPackedEventFields(
        event({
          tags: [
            ['e', E_TAG],
            ['p', P_TAG, 'wss://relay.example.com'],
          ],
        }),
      )

      expect(tags).to.deep.equal([
        { name: 'e', value: Buffer.from(E_TAG, 'hex') },
        { name: 'p', value: Buffer.from(P_TAG, 'hex') },
      ])
    })

    it('packs a tag that has only a name as an empty value', () => {
      expect(packedTags({ tags: [['t']] })).to.deep.equal([['t', '']])
    })

    it('skips values longer than 255 bytes, counting UTF-8 bytes', () => {
      expect(
        packedTags({
          tags: [
            ['t', 'a'.repeat(255)],
            ['t', 'a'.repeat(256)],
            ['t', 'é'.repeat(127)],
            ['t', 'é'.repeat(128)],
          ],
        }),
      ).to.deep.equal([
        ['t', 'a'.repeat(255)],
        ['t', 'é'.repeat(127)],
      ])
    })

    it('drops a one-character name that takes more than one byte', () => {
      expect(packedTags({ tags: [['é', 'x']] })).to.deep.equal([])
    })

    it('puts an empty d tag first for replaceable kinds', () => {
      for (const kind of [0, 3, 41, 10000, 10002, 19999]) {
        expect(packedTags({ kind, tags: [['t', 'x']] })).to.deep.equal([
          ['d', ''],
          ['t', 'x'],
        ])
      }
    })

    it('puts an empty d tag last for parameterized replaceable kinds', () => {
      for (const kind of [30000, 30023, 39999]) {
        expect(packedTags({ kind, tags: [['d', 'slug']] })).to.deep.equal([
          ['d', 'slug'],
          ['d', ''],
        ])
      }
    })

    it('adds no d tag for other kinds', () => {
      for (const kind of [1, 40, 9999, 20000, 29999, 40000]) {
        expect(packedTags({ kind })).to.deep.equal([])
      }
    })

    it('uses the first expiration tag and ignores later ones', () => {
      const fields = toPackedEventFields(
        event({
          tags: [
            ['expiration', '1800000000'],
            ['expiration', 'later'],
          ],
        }),
      )

      expect(fields.expiration).to.equal(1800000000n)
      expect(fields.tags).to.deep.equal([])
    })

    it('marks ephemeral events with expiration 1', () => {
      expect(toPackedEventFields(event({ kind: 20001, tags: [['expiration', '1800000000']] })).expiration).to.equal(1n)
      expect(toPackedEventFields(event({ kind: 29999 })).expiration).to.equal(1n)
    })

    it('leaves expiration at 0 when there is no expiration tag', () => {
      expect(toPackedEventFields(event()).expiration).to.equal(0n)
    })

    it('rejects expiration values strfry refuses', () => {
      for (const value of ['99', '0', '', 'soon', '-5', '1.5', '18446744073709551616']) {
        expect(() => toPackedEventFields(event({ tags: [['expiration', value]] })), value).to.throw(
          'Invalid expiration tag',
        )
      }
    })

    it('accepts the largest 64-bit expiration', () => {
      const fields = toPackedEventFields(event({ tags: [['expiration', '18446744073709551615']] }))

      expect(fields.expiration).to.equal(0xffff_ffff_ffff_ffffn)
    })

    it('decodes e and p values the way strfry does, prefix and upper case included', () => {
      const { tags } = toPackedEventFields(
        event({
          tags: [
            ['e', `0x${'ab'.repeat(31)}`],
            ['p', P_TAG.toUpperCase()],
          ],
        }),
      )

      expect(tags[0].value).to.deep.equal(Buffer.from('ab'.repeat(31), 'hex'))
      expect(tags[1].value).to.deep.equal(Buffer.from(P_TAG, 'hex'))
    })

    it('rejects events strfry could not have packed', () => {
      const invalid: EventOverrides[] = [
        { id: 'zz'.repeat(32) },
        { pubkey: 'ab'.repeat(31) },
        { created_at: -1 },
        { created_at: 1.5 },
        { kind: Number.MAX_SAFE_INTEGER + 1 },
        { tags: 'none' },
        { tags: [[]] },
        { tags: [['t', 1]] },
        { tags: [['e', 'ab'.repeat(31)]] },
        { tags: [['p', `${'ab'.repeat(31)}zz`]] },
      ]

      for (const overrides of invalid) {
        expect(() => toPackedEventFields(event(overrides)), JSON.stringify(overrides)).to.throw()
      }
    })
  })

  describe('serializePackedEvent', () => {
    it("lays the record out like strfry's PackedEventBuilder", () => {
      const fields = toPackedEventFields(
        event({
          kind: 30023,
          tags: [
            ['d', 'slug'],
            ['e', E_TAG],
            ['expiration', '1800000000'],
          ],
        }),
      )

      expect(serializePackedEvent(fields)).to.deep.equal(
        record(1700000000n, 30023n, 1800000000n, tag('d', 'slug'), tag('e', Buffer.from(E_TAG, 'hex')), tag('d', '')),
      )
    })

    it('reads back the same fields', () => {
      const fields = toPackedEventFields(
        event({
          kind: 10002,
          tags: [
            ['r', 'wss://relay.example.com'],
            ['p', P_TAG],
          ],
        }),
      )
      const view = new PackedEventView(serializePackedEvent(fields))

      expect(view.id).to.deep.equal(fields.id)
      expect(view.pubkey).to.deep.equal(fields.pubkey)
      expect(view.createdAt).to.equal(fields.createdAt)
      expect(view.kind).to.equal(fields.kind)
      expect(view.expiration).to.equal(Number(fields.expiration))
      expect(view.tags()).to.deep.equal(fields.tags)
    })

    it('rejects an id or pubkey that is not 32 bytes', () => {
      const fields = toPackedEventFields(event())

      expect(() => serializePackedEvent({ ...fields, id: Buffer.alloc(31) })).to.throw(
        'Event id and pubkey must be 32 bytes',
      )
    })

    it('rejects tags that do not fit the format', () => {
      const fields = toPackedEventFields(event())

      expect(() => serializePackedEvent({ ...fields, tags: [{ name: 't', value: Buffer.alloc(256) }] })).to.throw(
        'Tag t cannot be packed',
      )
      expect(() => serializePackedEvent({ ...fields, tags: [{ name: 'tt', value: Buffer.alloc(1) }] })).to.throw(
        'Tag tt cannot be packed',
      )
    })
  })
})
