/**
 * NIP-03 — OpenTimestamps Attestations for Events
 *
 * This module implements a structural parser and validator for binary `.ots`
 * (OpenTimestamps) proof files embedded as base64 in the `content` of a kind
 * 1040 event.
 *
 * Responsibilities of the relay (per NIP-03):
 *   1. The proof MUST prove the referenced `e`-tagged event id as its digest,
 *      i.e. the 32-byte file digest in the OTS header equals the event id
 *      referenced by the `e` tag.
 *   2. The content MUST be the full content of an `.ots` file containing at
 *      least one Bitcoin attestation.
 *   3. The file SHOULD NOT reference "pending" attestations (they are useless
 *      in this context). We accept but prefer their absence.
 *
 * Importantly, relays are NOT required (and it would be impractical) to verify
 * the OpenTimestamps proof against the actual Bitcoin blockchain. A real
 * Bitcoin node or an Esplora-like service is needed for that, and clients do
 * it themselves (e.g. `ots verify`). We perform _structural_ validation only:
 * magic header, hash op, digest match, and shape of the commitment tree.
 *
 * Wire format reference:
 *   https://github.com/opentimestamps/python-opentimestamps
 */

const MAGIC_HEADER = Buffer.from([
  0x00, 0x4f, 0x70, 0x65, 0x6e, 0x54, 0x69, 0x6d, 0x65, 0x73, 0x74, 0x61, 0x6d, 0x70, 0x73, 0x00, 0x00, 0x50, 0x72,
  0x6f, 0x6f, 0x66, 0x00, 0xbf, 0x89, 0xe2, 0xe8, 0x84, 0xe8, 0x92, 0x94,
])

// 8-byte attestation type tags, copied verbatim from the OpenTimestamps
// reference implementation. Treat them as opaque identifiers.
const BITCOIN_BLOCK_HEADER_ATTESTATION_TAG = Buffer.from([0x05, 0x88, 0x96, 0x0d, 0x73, 0xd7, 0x19, 0x01])
const PENDING_ATTESTATION_TAG = Buffer.from([0x83, 0xdf, 0xe3, 0x0d, 0x2e, 0xf9, 0x0c, 0x8e])
const LITECOIN_BLOCK_HEADER_ATTESTATION_TAG = Buffer.from([0x06, 0x86, 0x9a, 0x0d, 0x73, 0xd7, 0x1b, 0x45])
const ETHEREUM_BLOCK_HEADER_ATTESTATION_TAG = Buffer.from([0x30, 0xfe, 0x80, 0x87, 0xb5, 0xc7, 0xea, 0xd7])

// Operation tag bytes (1 byte each) as used in the OTS commitment tree.
const OP_SHA1 = 0x02
const OP_RIPEMD160 = 0x03
const OP_SHA256 = 0x08
const OP_KECCAK256 = 0x67
const OP_APPEND = 0xf0
const OP_PREPEND = 0xf1
const OP_REVERSE = 0xf2
const OP_HEXLIFY = 0xf3

// 1-byte structural markers in a Timestamp node.
const TAG_BRANCH = 0xff
const TAG_ATTESTATION = 0x00

// Safety limits. OTS proofs for Bitcoin are tiny in practice — a few hundred
// bytes, rarely more than ~1 KiB. The ceilings below are generous enough to
// accommodate unusual proofs while protecting the relay from memory-exhausting
// or stack-overflowing inputs.
const MAX_OTS_BYTES = 16 * 1024
const MAX_VARBYTES_LENGTH = 8 * 1024
const MAX_VARUINT_VALUE = Number.MAX_SAFE_INTEGER
const MAX_RECURSION_DEPTH = 128

// Only v1 of the OpenTimestamps file format is defined today. A future
// bump would change the byte layout we parse below, so treat anything else
// as unknown rather than best-effort decoding it.
const SUPPORTED_OTS_VERSION = 1

/**
 * Enum-like classification of attestations we care about. Unknown tags are
 * reported as `unknown` rather than hard-failing: the OTS format is explicitly
 * extensible, and future chains (or upgrade-aware implementations) may emit
 * tags we do not recognise. What matters for NIP-03 is that at least one
 * Bitcoin attestation is present.
 */
export type OtsAttestationKind = 'bitcoin' | 'pending' | 'litecoin' | 'ethereum' | 'unknown'

export interface OtsAttestation {
  kind: OtsAttestationKind
  /**
   * The 8-byte attestation type tag in lowercase hex. Useful for diagnostics
   * and for distinguishing unknown attestation types from each other.
   */
  tag: string
  /**
   * Block height for Bitcoin / Litecoin / Ethereum attestations. Undefined
   * when the attestation doesn't carry one (or failed to parse cleanly for
   * unknown tags — we don't trust the height of attestations we don't know
   * how to interpret).
   */
  height?: number
}

export interface OtsFileSummary {
  /** Major version number from the file header. Currently always 1. */
  version: number
  /** The hash operation used to digest the file being timestamped. */
  fileHashOp: 'sha1' | 'ripemd160' | 'sha256' | 'keccak256'
  /** Hex-encoded digest of the file being timestamped. */
  digest: string
  attestations: OtsAttestation[]
}

export type OtsParseResult = { ok: true; summary: OtsFileSummary } | { ok: false; reason: string }

/**
 * Minimal cursor over a Buffer used by the OTS parser. All reads are
 * bounds-checked; exceeding the buffer throws a descriptive error.
 *
 * Exported for unit tests only — application code should use `parseOtsFile`.
 */
export class OtsReader {
  private offset = 0

  public constructor(private readonly buf: Buffer) {}

  public get remaining(): number {
    return this.buf.length - this.offset
  }

  public readBytes(n: number): Buffer {
    if (n < 0) {
      throw new Error(`invalid negative read length ${n}`)
    }
    if (this.offset + n > this.buf.length) {
      throw new Error(`unexpected end of input (need ${n} bytes, have ${this.remaining})`)
    }
    const slice = this.buf.subarray(this.offset, this.offset + n)
    this.offset += n
    return slice
  }

  public readByte(): number {
    return this.readBytes(1)[0]
  }

  /**
   * Read a variable-length unsigned integer encoded as LEB128 (little-endian
   * base-128, MSB continuation bit). This matches the OpenTimestamps
   * reference implementation.
   */
  public readVarUint(): number {
    let value = 0
    let shift = 0
    for (;;) {
      if (shift > 56) {
        throw new Error('varint overflow')
      }
      const b = this.readByte()
      value += (b & 0x7f) * 2 ** shift
      if (!(b & 0x80)) {
        break
      }
      shift += 7
    }
    if (value > MAX_VARUINT_VALUE) {
      throw new Error('varint exceeds safe integer range')
    }
    return value
  }

  public readVarBytes(): Buffer {
    const len = this.readVarUint()
    if (len > MAX_VARBYTES_LENGTH) {
      throw new Error(`varbytes length ${len} exceeds maximum ${MAX_VARBYTES_LENGTH}`)
    }
    return this.readBytes(len)
  }
}

function classifyAttestationTag(tag: Buffer): OtsAttestationKind {
  if (tag.equals(BITCOIN_BLOCK_HEADER_ATTESTATION_TAG)) {
    return 'bitcoin'
  }
  if (tag.equals(PENDING_ATTESTATION_TAG)) {
    return 'pending'
  }
  if (tag.equals(LITECOIN_BLOCK_HEADER_ATTESTATION_TAG)) {
    return 'litecoin'
  }
  if (tag.equals(ETHEREUM_BLOCK_HEADER_ATTESTATION_TAG)) {
    return 'ethereum'
  }
  return 'unknown'
}

function readAttestation(reader: OtsReader): OtsAttestation {
  const tagBytes = reader.readBytes(8)
  const kind = classifyAttestationTag(tagBytes)
  // OTS wraps each attestation's payload in a length-prefixed blob so that
  // unknown attestation types can be skipped cleanly.
  const payload = reader.readVarBytes()

  const attestation: OtsAttestation = {
    kind,
    tag: tagBytes.toString('hex'),
  }

  if (kind === 'bitcoin' || kind === 'litecoin' || kind === 'ethereum') {
    // All three block-header attestations carry a single varint block height.
    // Read from the payload, not the outer reader, so we cannot run past the
    // payload boundary even if the attestation is malformed.
    const payloadReader = new OtsReader(payload)
    try {
      attestation.height = payloadReader.readVarUint()
    } catch {
      // leave height undefined
    }
  }

  return attestation
}

function isBinaryOp(op: number): boolean {
  return op === OP_APPEND || op === OP_PREPEND
}

function isUnaryOp(op: number): boolean {
  return (
    op === OP_SHA1 ||
    op === OP_RIPEMD160 ||
    op === OP_SHA256 ||
    op === OP_KECCAK256 ||
    op === OP_REVERSE ||
    op === OP_HEXLIFY
  )
}

function readOpArgIfAny(reader: OtsReader, op: number): void {
  if (isBinaryOp(op)) {
    // Binary ops carry a single length-prefixed byte string argument. We
    // don't need the value — we only need to skip past it — but we still
    // enforce the length limit via readVarBytes().
    reader.readVarBytes()
    return
  }
  if (isUnaryOp(op)) {
    return
  }
  throw new Error(`unknown op tag 0x${op.toString(16).padStart(2, '0')}`)
}

/**
 * Recursively parse a Timestamp node, collecting attestations as they are
 * encountered. The structure, per the reference implementation, is:
 *
 *     Timestamp := (0xff SubItem)* SubItem
 *     SubItem   := 0x00 Attestation      -- a leaf attestation
 *                | <opTag> [opArg] Timestamp -- an inner commitment
 *
 * `depth` is bounded to avoid blowing the JS call stack on pathological input.
 */
function readTimestamp(reader: OtsReader, attestations: OtsAttestation[], depth: number): void {
  if (depth > MAX_RECURSION_DEPTH) {
    throw new Error(`timestamp tree too deep (>${MAX_RECURSION_DEPTH})`)
  }

  for (;;) {
    const tag = reader.readByte()

    if (tag === TAG_BRANCH) {
      const inner = reader.readByte()
      readSubItem(reader, inner, attestations, depth + 1)
      continue
    }

    readSubItem(reader, tag, attestations, depth + 1)
    return
  }
}

function readSubItem(reader: OtsReader, tag: number, attestations: OtsAttestation[], depth: number): void {
  if (tag === TAG_ATTESTATION) {
    attestations.push(readAttestation(reader))
    return
  }
  readOpArgIfAny(reader, tag)
  readTimestamp(reader, attestations, depth)
}

function parseFileHashOp(op: number): { algo: OtsFileSummary['fileHashOp']; length: number } {
  switch (op) {
    case OP_SHA1:
      return { algo: 'sha1', length: 20 }
    case OP_RIPEMD160:
      return { algo: 'ripemd160', length: 20 }
    case OP_SHA256:
      return { algo: 'sha256', length: 32 }
    case OP_KECCAK256:
      return { algo: 'keccak256', length: 32 }
    default:
      throw new Error(`unsupported file hash op 0x${op.toString(16).padStart(2, '0')}`)
  }
}

/**
 * Parse a binary `.ots` file. Never throws: returns a discriminated union so
 * callers can surface a structured rejection reason to the client.
 */
export function parseOtsFile(buf: Buffer): OtsParseResult {
  if (!Buffer.isBuffer(buf) || buf.length === 0) {
    return { ok: false, reason: 'empty ots file' }
  }
  if (buf.length > MAX_OTS_BYTES) {
    return { ok: false, reason: `ots file exceeds ${MAX_OTS_BYTES} bytes` }
  }

  const reader = new OtsReader(buf)

  try {
    const magic = reader.readBytes(MAGIC_HEADER.length)
    if (!magic.equals(MAGIC_HEADER)) {
      return { ok: false, reason: 'invalid ots magic header' }
    }

    const version = reader.readVarUint()
    if (version !== SUPPORTED_OTS_VERSION) {
      return { ok: false, reason: `unsupported ots version ${version}` }
    }

    const fileHashOp = reader.readByte()
    const { algo, length } = parseFileHashOp(fileHashOp)

    const digest = reader.readBytes(length)

    const attestations: OtsAttestation[] = []
    readTimestamp(reader, attestations, 0)

    if (reader.remaining !== 0) {
      return { ok: false, reason: `trailing bytes after ots proof (${reader.remaining} left)` }
    }

    return {
      ok: true,
      summary: {
        version,
        fileHashOp: algo,
        digest: digest.toString('hex'),
        attestations,
      },
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'malformed ots file'
    return { ok: false, reason }
  }
}

/**
 * Validate the base64-encoded `.ots` proof embedded in a NIP-03 event's
 * content. Returns an error string on failure, or `undefined` on success.
 *
 * This enforces the three relay-observable requirements of NIP-03:
 *   - structurally valid OpenTimestamps proof file,
 *   - the proof's 32-byte SHA-256 file digest equals the hex-decoded target
 *     event id from the `e` tag, and
 *   - the proof contains at least one Bitcoin block header attestation (not
 *     merely pending calendars).
 */
export function validateOtsProof(base64Content: string, targetEventId: string): string | undefined {
  if (typeof base64Content !== 'string' || base64Content.length === 0) {
    return 'content is empty; expected base64-encoded ots file'
  }

  // Guard the base64 decoder. Node's permissive decoding silently drops bad
  // characters; we'd rather fail loudly and give the client a clear reason.
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64Content) || base64Content.length % 4 !== 0) {
    return 'content is not valid base64'
  }

  const buf = Buffer.from(base64Content, 'base64')

  const result = parseOtsFile(buf)
  if (result.ok !== true) {
    return `invalid ots proof: ${result.reason}`
  }

  const summary = result.summary

  if (summary.fileHashOp !== 'sha256') {
    return `ots proof must use sha256 file hash op (got ${summary.fileHashOp})`
  }

  const normalizedTarget = typeof targetEventId === 'string' ? targetEventId.toLowerCase() : ''
  if (!/^[0-9a-f]{64}$/.test(normalizedTarget)) {
    return 'target event id is not a 32-byte hex string'
  }

  if (summary.digest.toLowerCase() !== normalizedTarget) {
    return 'ots proof digest does not match the referenced event id'
  }

  const hasBitcoinAttestation = summary.attestations.some((att) => att.kind === 'bitcoin')
  if (!hasBitcoinAttestation) {
    return 'ots proof must contain at least one bitcoin attestation'
  }

  return undefined
}
