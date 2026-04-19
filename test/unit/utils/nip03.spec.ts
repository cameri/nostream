import { expect } from 'chai'

import { OtsParseResult, OtsReader, parseOtsFile, validateOtsProof } from '../../../src/utils/nip03'

/** LEB128-encode a non-negative integer that may exceed `Number.MAX_SAFE_INTEGER`. */
function leb128FromBigInt(n: bigint): Buffer {
  const bytes: number[] = []
  let v = n
  while (true) {
    const b = Number(v & 0x7fn)
    v >>= 7n
    if (v !== 0n) {
      bytes.push(b | 0x80)
    } else {
      bytes.push(b)
      break
    }
  }
  return Buffer.from(bytes)
}

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

const OP_SHA1 = 0x02
const OP_RIPEMD160 = 0x03
const OP_SHA256 = 0x08
const OP_KECCAK256 = 0x67
const OP_APPEND = 0xf0
const OP_PREPEND = 0xf1
const OP_REVERSE = 0xf2
const OP_HEXLIFY = 0xf3

const TAG_BRANCH = 0xff
const TAG_ATTESTATION = 0x00

const ETHEREUM_TAG = Buffer.from([0x30, 0xfe, 0x80, 0x87, 0xb5, 0xc7, 0xea, 0xd7])

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

function ethereumAttestation(height: number): Buffer {
  const payload = writeVarUint(height)
  return Buffer.concat([Buffer.from([TAG_ATTESTATION]), ETHEREUM_TAG, writeVarBytes(payload)])
}

/**
 * Build a minimal `.ots` file with a given file-hash op and digest length.
 * `subItems` are the attestation/op byte sequences; all but the last are
 * prefixed with the 0xff branch marker (same layout as `buildOts`).
 */
function buildOtsWithFileHashOp(fileHashOp: number, digest: Buffer, subItems: Buffer[]): Buffer {
  if (subItems.length === 0) {
    throw new Error('need at least one sub-item')
  }
  const parts: Buffer[] = [MAGIC, writeVarUint(1), Buffer.from([fileHashOp]), digest]
  for (let i = 0; i < subItems.length - 1; i++) {
    parts.push(Buffer.from([TAG_BRANCH]))
    parts.push(subItems[i])
  }
  parts.push(subItems[subItems.length - 1])
  return Buffer.concat(parts)
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

describe('OtsReader', () => {
  it('readBytes rejects a negative length', () => {
    const r = new OtsReader(Buffer.from([1, 2, 3]))
    expect(() => r.readBytes(-1)).to.throw(/invalid negative read length/)
  })

  it('readVarUint rejects values above Number.MAX_SAFE_INTEGER', () => {
    const encoded = leb128FromBigInt(BigInt(Number.MAX_SAFE_INTEGER) + 1n)
    const r = new OtsReader(encoded)
    expect(() => r.readVarUint()).to.throw(/exceeds safe integer range/)
  })
})

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

    it('rejects an unsupported ots file version', () => {
      const parts = [MAGIC, writeVarUint(2), Buffer.from([OP_SHA256]), DIGEST, bitcoinAttestation(1)]
      const buf = Buffer.concat(parts)
      const result = expectFailure(parseOtsFile(buf))
      expect(result.reason).to.match(/unsupported ots version/)
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

    it('rejects non-Buffer input the same as empty (typed array is not a Buffer)', () => {
      const result = expectFailure(parseOtsFile(new Uint8Array([0x01, 0x02]) as unknown as Buffer))
      expect(result.reason).to.equal('empty ots file')
    })

    it('parses sha1 file digest (20-byte) proofs', () => {
      const digest = Buffer.alloc(20, 0xab)
      const buf = buildOtsWithFileHashOp(OP_SHA1, digest, [bitcoinAttestation(1)])
      const result = expectSuccess(parseOtsFile(buf))
      expect(result.summary.fileHashOp).to.equal('sha1')
      expect(result.summary.digest).to.equal(digest.toString('hex'))
    })

    it('parses ripemd160 file digest proofs', () => {
      const digest = Buffer.alloc(20, 0xcd)
      const buf = buildOtsWithFileHashOp(OP_RIPEMD160, digest, [bitcoinAttestation(2)])
      const result = expectSuccess(parseOtsFile(buf))
      expect(result.summary.fileHashOp).to.equal('ripemd160')
    })

    it('parses keccak256 file digest proofs', () => {
      const digest = Buffer.alloc(32, 0xef)
      const buf = buildOtsWithFileHashOp(OP_KECCAK256, digest, [bitcoinAttestation(3)])
      const result = expectSuccess(parseOtsFile(buf))
      expect(result.summary.fileHashOp).to.equal('keccak256')
    })

    it('parses prepend binary op in the commitment tree', () => {
      const prepend = Buffer.concat([Buffer.from([OP_PREPEND]), writeVarBytes(Buffer.from([0x01]))])
      const buf = buildOts(DIGEST, [Buffer.concat([prepend, bitcoinAttestation(4)])])
      const result = expectSuccess(parseOtsFile(buf))
      expect(result.summary.attestations.some((a) => a.kind === 'bitcoin')).to.equal(true)
    })

    it('parses reverse and hexlify unary ops wrapping an attestation', () => {
      const revThenHex = Buffer.concat([Buffer.from([OP_REVERSE]), Buffer.from([OP_HEXLIFY]), bitcoinAttestation(5)])
      const buf = buildOts(DIGEST, [revThenHex])
      const result = expectSuccess(parseOtsFile(buf))
      expect(result.summary.attestations[0].kind).to.equal('bitcoin')
    })

    it('classifies ethereum block header attestations', () => {
      const buf = buildOts(DIGEST, [ethereumAttestation(18_000_000)])
      const result = expectSuccess(parseOtsFile(buf))
      const eth = result.summary.attestations.find((a) => a.kind === 'ethereum')
      expect(eth).to.exist
      expect(eth?.height).to.equal(18_000_000)
    })

    it('treats a truncated bitcoin attestation payload as height-less', () => {
      const broken = Buffer.concat([Buffer.from([TAG_ATTESTATION]), BITCOIN_TAG, writeVarUint(0)])
      const buf = buildOts(DIGEST, [broken])
      const result = expectSuccess(parseOtsFile(buf))
      expect(result.summary.attestations[0]).to.include({ kind: 'bitcoin' })
      expect(result.summary.attestations[0].height).to.equal(undefined)
    })

    it('rejects unknown commitment op tags', () => {
      const buf = Buffer.concat([MAGIC, writeVarUint(1), Buffer.from([OP_SHA256]), DIGEST, Buffer.from([0xfe])])
      const result = expectFailure(parseOtsFile(buf))
      expect(result.reason).to.match(/unknown op tag/)
    })

    it('rejects varints that overflow the LEB128 decoder', () => {
      const buf = Buffer.concat([MAGIC, Buffer.alloc(9, 0x80)])
      const result = expectFailure(parseOtsFile(buf))
      expect(result.reason).to.match(/varint overflow/)
    })

    it('rejects varbytes length fields above the relay maximum', () => {
      const buf = Buffer.concat([
        MAGIC,
        writeVarUint(1),
        Buffer.from([OP_SHA256]),
        DIGEST,
        Buffer.from([OP_APPEND]),
        writeVarUint(8193),
      ])
      const result = expectFailure(parseOtsFile(buf))
      expect(result.reason).to.match(/exceeds maximum/)
    })

    it('rejects commitment trees deeper than the recursion cap', () => {
      // 129 nested (0xff, OP_SHA256) pairs: readTimestamp(128) then dispatches into
      // readTimestamp(129), which exceeds MAX_RECURSION_DEPTH (128).
      const pairs = 129
      const nested = Buffer.alloc(pairs * 2)
      for (let i = 0; i < pairs; i++) {
        nested[i * 2] = TAG_BRANCH
        nested[i * 2 + 1] = OP_SHA256
      }
      const buf = Buffer.concat([MAGIC, writeVarUint(1), Buffer.from([OP_SHA256]), DIGEST, nested])
      const result = expectFailure(parseOtsFile(buf))
      expect(result.reason).to.match(/too deep/)
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

    it('rejects a non-string target event id', () => {
      expect(validateOtsProof(validProof, null as unknown as string)).to.match(/not a 32-byte hex/)
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
