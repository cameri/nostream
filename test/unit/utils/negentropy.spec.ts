import { expect } from 'chai'
import { createHash } from 'crypto'

import { MAX_TIMESTAMP, Negentropy, NegentropyStorageVector } from '../../../src/utils/negentropy'

const BASE_TIMESTAMP = 1700000000

const idFor = (label: string): Buffer => createHash('sha256').update(label).digest()

type Entry = [timestamp: number, id: Buffer]

const buildEntries = (from: number, to: number, perTimestamp = 4): Entry[] => {
  const entries: Entry[] = []
  for (let i = from; i < to; i++) {
    entries.push([BASE_TIMESTAMP + Math.floor(i / perTimestamp), idFor(`negentropy-test-${i}`)])
  }

  return entries
}

const buildStorage = (entries: Entry[]): NegentropyStorageVector => {
  const storage = new NegentropyStorageVector()
  for (const [timestamp, id] of entries) {
    storage.insert(timestamp, id)
  }
  storage.seal()

  return storage
}

const hex = (bytes: Uint8Array | null): string => (bytes ? Buffer.from(bytes).toString('hex') : 'null')

const idsOf = (entries: Entry[]): string[] => entries.map(([, id]) => id.toString('hex'))

const difference = (left: Entry[], right: Entry[]): string[] => {
  const rightIds = new Set(idsOf(right))

  return idsOf(left)
    .filter((id) => !rightIds.has(id))
    .sort()
}

interface SyncOutcome {
  rounds: number
  haveIds: string[]
  needIds: string[]
}

// Runs a full session: `client` initiates, `server` only answers, until the client has nothing left to say.
const sync = (client: Entry[], server: Entry[], serverFrameSizeLimit = 0): SyncOutcome => {
  const initiator = new Negentropy(buildStorage(client))
  const responder = new Negentropy(buildStorage(server), serverFrameSizeLimit)
  // Under a frame size limit the same id can be reported again in a later round, exactly as in the
  // reference implementation, so an initiator has to accumulate into a set.
  const haveIds = new Set<string>()
  const needIds = new Set<string>()

  let message: Uint8Array | null = initiator.initiate()
  let rounds = 0
  while (message !== null) {
    rounds++
    expect(rounds, 'session did not converge').to.be.lessThan(50)

    const reply = responder.reconcile(message).output
    const result = initiator.reconcile(reply as Uint8Array)
    result.haveIds.forEach((id) => haveIds.add(id))
    result.needIds.forEach((id) => needIds.add(id))
    message = result.output
  }

  return { rounds, haveIds: [...haveIds].sort(), needIds: [...needIds].sort() }
}

describe('negentropy', () => {
  describe('NegentropyStorageVector', () => {
    it('rejects ids that are not 32 bytes', () => {
      const storage = new NegentropyStorageVector()

      expect(() => storage.insert(BASE_TIMESTAMP, Buffer.alloc(31))).to.throw('bad id size for added item')
    })

    it('rejects timestamps that are negative, fractional or the infinity sentinel', () => {
      const storage = new NegentropyStorageVector()

      expect(() => storage.insert(-1, idFor('a'))).to.throw('bad timestamp')
      expect(() => storage.insert(1.5, idFor('a'))).to.throw('bad timestamp')
      expect(() => storage.insert(MAX_TIMESTAMP, idFor('a'))).to.throw('bad timestamp')
    })

    it('refuses to insert or seal twice once sealed', () => {
      const storage = buildStorage(buildEntries(0, 2))

      expect(() => storage.insert(BASE_TIMESTAMP, idFor('late'))).to.throw('already sealed')
      expect(() => storage.seal()).to.throw('already sealed')
    })

    it('rejects duplicate items when sealing', () => {
      const storage = new NegentropyStorageVector()
      storage.insert(BASE_TIMESTAMP, idFor('dup'))
      storage.insert(BASE_TIMESTAMP, idFor('dup'))

      expect(() => storage.seal()).to.throw('duplicate item inserted')
    })

    it('refuses to be read before it is sealed', () => {
      const storage = new NegentropyStorageVector()

      expect(() => storage.size()).to.throw('not sealed')
      expect(() => storage.fingerprint(0, 0)).to.throw('not sealed')
    })

    it('sorts by timestamp, then by id', () => {
      const low = Buffer.alloc(32, 0x01)
      const high = Buffer.alloc(32, 0x02)
      const storage = new NegentropyStorageVector()
      storage.insert(BASE_TIMESTAMP + 1, low)
      storage.insert(BASE_TIMESTAMP, high)
      storage.insert(BASE_TIMESTAMP, low)
      storage.seal()

      const order: string[] = []
      storage.iterate(0, storage.size(), (item) => {
        order.push(`${item.timestamp - BASE_TIMESTAMP}:${item.id[0]}`)
        return true
      })

      expect(order).to.deep.equal(['0:1', '0:2', '1:1'])
    })

    it('finds the lower bound of a bound', () => {
      const storage = buildStorage(buildEntries(0, 10, 1))

      expect(storage.findLowerBound(0, 10, { timestamp: 0, id: new Uint8Array(0) })).to.equal(0)
      expect(storage.findLowerBound(0, 10, { timestamp: BASE_TIMESTAMP + 3, id: new Uint8Array(0) })).to.equal(3)
      expect(storage.findLowerBound(0, 10, { timestamp: BASE_TIMESTAMP + 99, id: new Uint8Array(0) })).to.equal(10)
      expect(storage.findLowerBound(0, 10, { timestamp: MAX_TIMESTAMP, id: new Uint8Array(0) })).to.equal(10)
    })

    it('rejects out-of-range bounds', () => {
      const storage = buildStorage(buildEntries(0, 3))

      expect(() => storage.iterate(0, 4, () => true)).to.throw('bad range')
      expect(() => storage.fingerprint(2, 1)).to.throw('bad range')
    })

    it('produces 16-byte fingerprints that do not depend on insertion order', () => {
      const entries = buildEntries(0, 8)
      const forward = buildStorage(entries)
      const backward = buildStorage([...entries].reverse())

      expect(forward.fingerprint(0, 8)).to.have.lengthOf(16)
      expect(hex(forward.fingerprint(0, 8))).to.equal(hex(backward.fingerprint(0, 8)))
    })

    it('produces different fingerprints for different sets and for different counts', () => {
      const storage = buildStorage(buildEntries(0, 8))
      const other = buildStorage(buildEntries(1, 9))

      expect(hex(storage.fingerprint(0, 8))).to.not.equal(hex(other.fingerprint(0, 8)))
      expect(hex(storage.fingerprint(0, 4))).to.not.equal(hex(storage.fingerprint(0, 5)))
    })

    it('wraps the 256-bit id sum around, carrying across every 32-bit word', () => {
      const allOnes = Buffer.alloc(32, 0xff)
      const one = Buffer.alloc(32)
      one[0] = 1
      const zero = Buffer.alloc(32)

      const overflowing = new NegentropyStorageVector()
      overflowing.insert(BASE_TIMESTAMP, allOnes)
      overflowing.insert(BASE_TIMESTAMP, one)
      overflowing.seal()

      const zeroSum = new NegentropyStorageVector()
      zeroSum.insert(BASE_TIMESTAMP, zero)
      zeroSum.insert(BASE_TIMESTAMP + 1, zero)
      zeroSum.seal()

      // (2^256 - 1) + 1 wraps to exactly 0 only if the carry ripples through all eight words.
      expect(hex(overflowing.fingerprint(0, 2))).to.equal(hex(zeroSum.fingerprint(0, 2)))
    })
  })

  describe('wire compatibility with the reference implementation', () => {
    // Generated with hoytech/negentropy js/Negentropy.js: client holds items 0-39, server holds 10-49.
    const REFERENCE_FIRST_MESSAGE =
      '6186aacfe20101c4019519545952534ac1dbf6efee31f306a50201bf010e45e53bc3ac3b96527fcd6c09d2047802017101744f77934468e967eeeabc0f798d8ef4020001873c27d9520afdf1a90c94fc3418b485010165011eb5a27d5fd29d201a8804d82fe10c2e02018e013ee24cc071884f88d81e56c138672c4402015801ce08fb40009f4496c99e002ce58159b402000166784dbdc5e2e720329752a4d7fe1fdc0101ca01e53cc691284a4fa5d32d61bf920bd03f020001392bfa2b9c1ea6c1e44575ee2cd47a9f0101cd01161b325b1e6b1f8c0e5e6dcce95c673a020001db0d53fffe5622719353467e5a4064340101a101f1c06ede4cff82a242fda6253d18a06f020001d5785181bb433c6f0d3ff48de323251a01019c01a054d5da1b42babccc1272c167eb56db0000015dfae5a6e074b6e1d2014f2b9134c08f'
    const REFERENCE_RESPONSE =
      '6186aacfe20101c402000201bf02000201710200020002029103607c71902fd449f5737b2dda7c5a4ee31e0cf1fb7cf13f2f951d3b131c169266fae12bbe176c85e6cc8940ff97afc4b7f899f13192cbd756856aaa06261f07019c000000020c9c185f5a0cb59b837e6ffc631a537507a7eefede982d9663577ae545fab5b287d0f8bae1791c4ccb49a9c267107c73043df98a26bc696febebd84c864beb68160f39aca329fab189af2e828cd50a518ac803854a3ae5c280b1e3873cdefc268e609a8d39e4370faed4290168ca6c9a7237f0e29923b0e48b45eb5ae6851bca6f8120620c1dfeb40c48a28f4e2dfe67c3f0cf490d80602e30a383700fb85cedf68d7f261ad6c9ff45c56880496fb12b1a1209c701ad76fbca9684a3490e1467a0689fb4d021cd5fa4ba91eda8283b7daddccd70fe41e26e6a502c17de020038ba6e665739195287c00becd4b248675c994d7c10f4b5a12c524b9b62e308740e31e05b1a766d5ba1ebf8ba17bee7da0164907525d095b6f18fbc3dd5b8197c1e11e56cdae96afbdba7c20dab5ddf6d34daa1847b809f79ada60945b8305d51448a6c8109848821eae5957bf56c1c8ca51b10d06cbbfda2ebcdbc8f5163a2cf6d5ddc25b6dde85fbcdb2e25ee0ec80c7815bf9784c8a710c66536a094bff846333d'

    it('encodes the same first message as the reference', () => {
      const client = new Negentropy(buildStorage(buildEntries(0, 40)))

      expect(hex(client.initiate())).to.equal(REFERENCE_FIRST_MESSAGE)
    })

    it('answers that message exactly like the reference', () => {
      const server = new Negentropy(buildStorage(buildEntries(10, 50)))

      const { output } = server.reconcile(Buffer.from(REFERENCE_FIRST_MESSAGE, 'hex'))

      expect(hex(output)).to.equal(REFERENCE_RESPONSE)
    })

    it('encodes an empty set as a single empty id list', () => {
      const client = new Negentropy(buildStorage([]))

      expect(hex(client.initiate())).to.equal('6100000200')
    })
  })

  describe('reconciliation', () => {
    it('finds nothing to sync between identical sets', () => {
      const entries = buildEntries(0, 200)

      const outcome = sync(entries, entries)

      expect(outcome.haveIds).to.deep.equal([])
      expect(outcome.needIds).to.deep.equal([])
      expect(outcome.rounds).to.equal(1)
    })

    it('reports everything as needed when the client has nothing', () => {
      const server = buildEntries(0, 50)

      const outcome = sync([], server)

      expect(outcome.haveIds).to.deep.equal([])
      expect(outcome.needIds).to.deep.equal(idsOf(server).sort())
    })

    it('reports everything as had when the server has nothing', () => {
      const client = buildEntries(0, 50)

      const outcome = sync(client, [])

      expect(outcome.haveIds).to.deep.equal(idsOf(client).sort())
      expect(outcome.needIds).to.deep.equal([])
    })

    it('handles completely disjoint sets', () => {
      const client = buildEntries(0, 100)
      const server = buildEntries(1000, 1100)

      const outcome = sync(client, server)

      expect(outcome.haveIds).to.deep.equal(idsOf(client).sort())
      expect(outcome.needIds).to.deep.equal(idsOf(server).sort())
    })

    for (const [clientSize, serverSize, serverOffset] of [
      [500, 480, 10],
      [3000, 2900, 100],
      [40, 5000, 0],
    ]) {
      it(`converges on the exact difference for ${clientSize} vs ${serverSize} items`, () => {
        const client = buildEntries(0, clientSize)
        const server = buildEntries(0, serverSize).slice(serverOffset)

        const outcome = sync(client, server)

        expect(outcome.haveIds).to.deep.equal(difference(client, server))
        expect(outcome.needIds).to.deep.equal(difference(server, client))
      })
    }

    it('converges when thousands of events share one timestamp', () => {
      const client = buildEntries(0, 1500, 1500)
      const server = buildEntries(100, 1600, 1500)

      const outcome = sync(client, server)

      expect(outcome.haveIds).to.deep.equal(difference(client, server))
      expect(outcome.needIds).to.deep.equal(difference(server, client))
    })

    it('converges under a small frame size limit, in more rounds', () => {
      // Large differences force the responder to cut its answer short and defer the rest.
      const client = buildEntries(0, 3000)
      const server = buildEntries(5000, 8000)

      const unlimited = sync(client, server)
      const limited = sync(client, server, 4096)

      expect(limited.haveIds).to.deep.equal(difference(client, server))
      expect(limited.needIds).to.deep.equal(difference(server, client))
      expect(limited.rounds).to.be.greaterThan(unlimited.rounds)
    })

    it('keeps every responder message within the frame size limit', () => {
      const frameSizeLimit = 4096
      const initiator = new Negentropy(buildStorage(buildEntries(0, 3000)))
      const responder = new Negentropy(buildStorage(buildEntries(5000, 8000)), frameSizeLimit)

      let message: Uint8Array | null = initiator.initiate()
      while (message !== null) {
        const reply = responder.reconcile(message).output as Uint8Array
        expect(reply.byteLength).to.be.at.most(frameSizeLimit)
        message = initiator.reconcile(reply).output
      }
    })

    it('rejects frame size limits below 4096', () => {
      expect(() => new Negentropy(buildStorage([]), 4095)).to.throw('frameSizeLimit too small')
      expect(() => new Negentropy(buildStorage([]), 0)).to.not.throw()
    })

    it('refuses to initiate twice', () => {
      const client = new Negentropy(buildStorage([]))
      client.initiate()

      expect(() => client.initiate()).to.throw('already initiated')
    })

    it('can run several independent sessions over the same storage', () => {
      const storage = buildStorage(buildEntries(10, 50))
      const first = new Negentropy(storage)
      const second = new Negentropy(storage)
      const message = new Negentropy(buildStorage(buildEntries(0, 40))).initiate()

      expect(hex(first.reconcile(message).output)).to.equal(hex(second.reconcile(message).output))
    })
  })

  describe('malformed input', () => {
    const responder = () => new Negentropy(buildStorage(buildEntries(0, 100)))

    it('rejects an empty message', () => {
      expect(() => responder().reconcile(new Uint8Array(0))).to.throw('parse ends prematurely')
    })

    it('rejects a version byte outside 0x60-0x6f', () => {
      expect(() => responder().reconcile(Uint8Array.of(0x42))).to.throw('invalid negentropy protocol version byte')
    })

    it('answers an unsupported but well-formed version with just its own version byte', () => {
      const { output } = responder().reconcile(Uint8Array.of(0x62))

      expect(hex(output)).to.equal('61')
    })

    it('throws when the initiator is answered with an unsupported version', () => {
      const initiator = new Negentropy(buildStorage([]))
      initiator.initiate()

      expect(() => initiator.reconcile(Uint8Array.of(0x62))).to.throw('unsupported negentropy protocol version')
    })

    it('rejects an unknown mode', () => {
      // bound(timestamp 0 -> infinity, empty id), mode 7
      expect(() => responder().reconcile(Uint8Array.of(0x61, 0x00, 0x00, 0x07))).to.throw('unexpected mode')
    })

    it('rejects a bound id longer than 32 bytes', () => {
      expect(() => responder().reconcile(Uint8Array.of(0x61, 0x00, 33))).to.throw('bound key too long')
    })

    it('rejects a truncated fingerprint', () => {
      expect(() => responder().reconcile(Uint8Array.of(0x61, 0x00, 0x00, 0x01, 0xaa))).to.throw(
        'parse ends prematurely',
      )
    })

    it('rejects an id list that claims more ids than the message carries', () => {
      // mode 2 (id list), count 100, no ids follow
      expect(() => responder().reconcile(Uint8Array.of(0x61, 0x00, 0x00, 0x02, 100))).to.throw('parse ends prematurely')
    })

    it('rejects an id list whose declared size would overflow when multiplied out', () => {
      const huge = Uint8Array.of(0x61, 0x00, 0x00, 0x02, 0xff, 0xff, 0xff, 0xff, 0x7f)

      expect(() => responder().reconcile(huge)).to.throw('parse ends prematurely')
    })

    it('rejects varints that never terminate', () => {
      const endless = Uint8Array.of(0x61, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80)

      expect(() => responder().reconcile(endless)).to.throw('varint too long')
    })

    it('rejects varints beyond the safe integer range', () => {
      const tooBig = Uint8Array.of(0x61, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x7f)

      expect(() => responder().reconcile(tooBig)).to.throw('varint out of range')
    })

    it('does not mutate its storage when the input is rejected', () => {
      const storage = buildStorage(buildEntries(0, 100))
      const before = hex(storage.fingerprint(0, 100))

      expect(() => new Negentropy(storage).reconcile(Uint8Array.of(0x61, 0x00, 33))).to.throw()

      expect(hex(storage.fingerprint(0, 100))).to.equal(before)
    })
  })
})
