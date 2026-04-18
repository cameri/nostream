import { expect } from 'chai'

import { OtsParseResult, parseOtsFile, validateOtsProof } from '../../../src/utils/nip03'

function expectFailure(result: OtsParseResult): { ok: false; reason: string } {
  if (result.ok !== false) {
    throw new Error('expected a failure result')
  }
  return result as { ok: false; reason: string }
}

function expectSuccess(result: OtsParseResult): Extract<OtsParseResult, { ok: true }> {
  if (result.ok !== true) {
    throw new Error(`expected a success result, got ${(result as any).reason}`)
  }
  return result as Extract<OtsParseResult, { ok: true }>
}

// ---------------------------------------------------------------------------
// Binary OTS builder helpers
//
// Encode synthetic `.ots` files so we can exercise the parser without shelling
// out to the `ots` CLI in unit tests. The byte layout mirrors what
// python-opentimestamps produces; see src/utils/nip03.ts for the format.
// ---------------------------------------------------------------------------

const MAGIC = Buffer.from([
  0x00, 0x4f, 0x70, 0x65, 0x6e, 0x54, 0x69, 0x6d, 0x65, 0x73, 0x74, 0x61, 0x6d, 0x70, 0x73, 0x00, 0x00, 0x50, 0x72,
  0x6f, 0x6f, 0x66, 0x00, 0xbf, 0x89, 0xe2, 0xe8, 0x84, 0xe8, 0x92, 0x94,
])

const BITCOIN_TAG = Buffer.from([0x05, 0x88, 0x96, 0x0d, 0x73, 0xd7, 0x19, 0x01])
const PENDING_TAG = Buffer.from([0x83, 0xdf, 0xe3, 0x0d, 0x2e, 0xf9, 0x0c, 0x8e])
const LITECOIN_TAG = Buffer.from([0x06, 0x86, 0x9a, 0x0d, 0x73, 0xd7, 0x1b, 0x45])
const UNKNOWN_TAG = Buffer.from([0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff, 0x00, 0x11])

const OP_SHA256 = 0x08
const OP_APPEND = 0xf0

const TAG_BRANCH = 0xff
const TAG_ATTESTATION = 0x00

function writeVarUint(n: number): Buffer {
  const bytes: number[] = []
  let value = n
  if (value === 0) {
    return Buffer.from([0])
  }
  while (value !== 0) {
    let b = value & 0x7f
    value = Math.floor(value / 128)
    if (value !== 0) {
      b |= 0x80
    }
    bytes.push(b)
  }
  return Buffer.from(bytes)
}

function writeVarBytes(buf: Buffer): Buffer {
  return Buffer.concat([writeVarUint(buf.length), buf])
}

function bitcoinAttestation(height: number): Buffer {
  // [0x00][8-byte tag][varint len][varint height payload]
  const payload = writeVarUint(height)
  return Buffer.concat([Buffer.from([TAG_ATTESTATION]), BITCOIN_TAG, writeVarBytes(payload)])
}

function pendingAttestation(url: string): Buffer {
  const payload = writeVarBytes(Buffer.from(url, 'utf8'))
  return Buffer.concat([Buffer.from([TAG_ATTESTATION]), PENDING_TAG, writeVarBytes(payload)])
}

function litecoinAttestation(height: number): Buffer {
  const payload = writeVarUint(height)
  return Buffer.concat([Buffer.from([TAG_ATTESTATION]), LITECOIN_TAG, writeVarBytes(payload)])
}

function unknownAttestation(payload: Buffer): Buffer {
  return Buffer.concat([Buffer.from([TAG_ATTESTATION]), UNKNOWN_TAG, writeVarBytes(payload)])
}

/**
 * Build a minimal SHA256-digest `.ots` file whose commitment tree is a single
 * leaf attestation. `subItems` are the attestation/op byte sequences that
 * make up the tree; all but the last are prefixed with the 0xff branch marker.
 */
function buildOts(digest: Buffer, subItems: Buffer[]): Buffer {
  if (subItems.length === 0) {
    throw new Error('need at least one sub-item')
  }
  const parts: Buffer[] = [MAGIC, writeVarUint(1), Buffer.from([OP_SHA256]), digest]
  for (let i = 0; i < subItems.length - 1; i++) {
    parts.push(Buffer.from([TAG_BRANCH]))
    parts.push(subItems[i])
  }
  parts.push(subItems[subItems.length - 1])
  return Buffer.concat(parts)
}

const EVENT_ID = 'e71c6ea722987debdb60f81f9ea4f604b5ac0664120dd64fb9d23abc4ec7c323'
const DIGEST = Buffer.from(EVENT_ID, 'hex')

describe('NIP-03 — OpenTimestamps', () => {
  describe('parseOtsFile', () => {
    it('parses a minimal proof with a single bitcoin attestation', () => {
      const buf = buildOts(DIGEST, [bitcoinAttestation(810391)])

      const result = expectSuccess(parseOtsFile(buf))

      expect(result.summary.version).to.equal(1)
      expect(result.summary.fileHashOp).to.equal('sha256')
      expect(result.summary.digest).to.equal(EVENT_ID)
      expect(result.summary.attestations).to.have.lengthOf(1)
      expect(result.summary.attestations[0]).to.include({ kind: 'bitcoin', height: 810391 })
    })

    it('parses a proof with ops that wrap an attestation', () => {
      const opAppend = Buffer.concat([Buffer.from([OP_APPEND]), writeVarBytes(Buffer.from([0xde, 0xad, 0xbe, 0xef]))])
      const tree = Buffer.concat([opAppend, bitcoinAttestation(1)])
      const buf = buildOts(DIGEST, [tree])

      const result = expectSuccess(parseOtsFile(buf))

      expect(result.summary.attestations.map((a) => a.kind)).to.deep.equal(['bitcoin'])
    })

    it('parses a proof with multiple attestations (pending + bitcoin)', () => {
      const buf = buildOts(DIGEST, [pendingAttestation('https://a.pool.opentimestamps.org'), bitcoinAttestation(42)])

      const result = expectSuccess(parseOtsFile(buf))
      const kinds = result.summary.attestations.map((a) => a.kind).sort()
      expect(kinds).to.deep.equal(['bitcoin', 'pending'])
    })

    it('classifies litecoin and unknown attestations correctly', () => {
      const buf = buildOts(DIGEST, [litecoinAttestation(2500000), unknownAttestation(Buffer.from([1, 2, 3]))])

      const result = expectSuccess(parseOtsFile(buf))
      const kinds = result.summary.attestations.map((a) => a.kind).sort()
      expect(kinds).to.deep.equal(['litecoin', 'unknown'])
    })

    it('rejects a file without the OpenTimestamps magic header', () => {
      const buf = Buffer.concat([Buffer.alloc(MAGIC.length), writeVarUint(1), Buffer.from([OP_SHA256]), DIGEST])
      const result = expectFailure(parseOtsFile(buf))
      expect(result.reason).to.match(/magic header/)
    })

    it('rejects an unsupported file hash op', () => {
      const parts = [MAGIC, writeVarUint(1), Buffer.from([0x55]), Buffer.alloc(32), bitcoinAttestation(1)]
      const buf = Buffer.concat(parts)
      const result = expectFailure(parseOtsFile(buf))
      expect(result.reason).to.match(/unsupported file hash op/)
    })

    it('rejects truncated proofs without crashing', () => {
      const good = buildOts(DIGEST, [bitcoinAttestation(1)])
      const truncated = good.subarray(0, good.length - 3)
      expectFailure(parseOtsFile(truncated))
    })

    it('rejects proofs with trailing garbage', () => {
      const good = buildOts(DIGEST, [bitcoinAttestation(1)])
      const withGarbage = Buffer.concat([good, Buffer.from([0x00, 0x11, 0x22])])
      const result = expectFailure(parseOtsFile(withGarbage))
      expect(result.reason).to.match(/trailing bytes/)
    })

    it('refuses files larger than the configured maximum', () => {
      const result = expectFailure(parseOtsFile(Buffer.alloc(32 * 1024)))
      expect(result.reason).to.match(/exceeds/)
    })

    it('returns a structured failure on empty input instead of throwing', () => {
      expectFailure(parseOtsFile(Buffer.alloc(0)))
    })
  })

  describe('validateOtsProof', () => {
    const validProof = buildOts(DIGEST, [bitcoinAttestation(810391)]).toString('base64')

    it('accepts a well-formed bitcoin-anchored proof whose digest matches', () => {
      expect(validateOtsProof(validProof, EVENT_ID)).to.equal(undefined)
    })

    it('accepts uppercase hex target ids and normalizes them', () => {
      expect(validateOtsProof(validProof, EVENT_ID.toUpperCase())).to.equal(undefined)
    })

    it('rejects empty content', () => {
      expect(validateOtsProof('', EVENT_ID)).to.match(/empty/)
    })

    it('rejects non-base64 content', () => {
      expect(validateOtsProof('!!! not base64 !!!', EVENT_ID)).to.match(/not valid base64/)
    })

    it('rejects proofs whose digest does not match the event id', () => {
      const other = '0'.repeat(64)
      expect(validateOtsProof(validProof, other)).to.match(/digest does not match/)
    })

    it('rejects target ids that are not 32-byte hex', () => {
      expect(validateOtsProof(validProof, 'not-an-id')).to.match(/not a 32-byte hex/)
    })

    it('rejects proofs without any bitcoin attestation', () => {
      const onlyPending = buildOts(DIGEST, [pendingAttestation('https://a.pool.opentimestamps.org')]).toString('base64')
      expect(validateOtsProof(onlyPending, EVENT_ID)).to.match(/bitcoin attestation/)
    })

    it('rejects a proof digested with a non-sha256 hash op', () => {
      // Construct a manual RIPEMD160 file (20-byte digest) — this should fail
      // the sha256 requirement even though the parser would otherwise accept it.
      const parts = [MAGIC, writeVarUint(1), Buffer.from([0x03]), Buffer.alloc(20, 0xaa), bitcoinAttestation(1)]
      const ripemd = Buffer.concat(parts).toString('base64')
      expect(validateOtsProof(ripemd, 'aa'.repeat(32))).to.match(/sha256 file hash op/)
    })
  })
})
