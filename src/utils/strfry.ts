import { Event } from '../@types/event'

// strfry's packed event layout (PackedEvent.h), integers little-endian:
//   0 id (32) | 32 pubkey (32) | 64 created_at (8) | 72 kind (8) | 80 expiration (8)
//   88 tags: name (1), length (1), value
export const PACKED_EVENT_HEADER_SIZE = 88

const MAX_PACKED_TAG_VALUE_SIZE = 255
const MAX_UINT64 = 0xffff_ffff_ffff_ffffn
const MIN_EXPIRATION = 100n
const EPHEMERAL_EXPIRATION = 1n

export interface PackedTag {
  name: string
  value: Buffer
}

// Exact up to 2^53.
const readUInt64 = (buffer: Buffer, offset: number): number =>
  buffer.readUInt32LE(offset) + buffer.readUInt32LE(offset + 4) * 0x1_0000_0000

export class PackedEventView {
  public constructor(private readonly buffer: Buffer) {
    if (buffer.length < PACKED_EVENT_HEADER_SIZE) {
      throw new Error(`Packed event is ${buffer.length} bytes, expected at least ${PACKED_EVENT_HEADER_SIZE}`)
    }
  }

  public get id(): Buffer {
    return this.buffer.subarray(0, 32)
  }

  public get pubkey(): Buffer {
    return this.buffer.subarray(32, 64)
  }

  public get createdAt(): number {
    return readUInt64(this.buffer, 64)
  }

  public get kind(): number {
    return readUInt64(this.buffer, 72)
  }

  // 0 = never expires, 1 = ephemeral
  public get expiration(): number {
    return readUInt64(this.buffer, 80)
  }

  public tags(): PackedTag[] {
    const tags: PackedTag[] = []
    let offset = PACKED_EVENT_HEADER_SIZE

    while (offset < this.buffer.length) {
      if (offset + 2 > this.buffer.length) {
        throw new Error(`Packed event ends inside a tag header at byte ${offset}`)
      }

      const end = offset + 2 + this.buffer[offset + 1]
      if (end > this.buffer.length) {
        throw new Error(`Packed event tag at byte ${offset} runs past the end of the record`)
      }

      tags.push({ name: String.fromCharCode(this.buffer[offset]), value: this.buffer.subarray(offset + 2, end) })
      offset = end
    }

    return tags
  }
}

// Kind ranges from strfry's EventUtils.h.
const isReplaceableKind = (kind: number): boolean =>
  kind === 0 || kind === 3 || kind === 41 || (kind >= 10000 && kind < 20000)

const isParameterizedReplaceableKind = (kind: number): boolean => kind >= 30000 && kind < 40000

const isEphemeralKind = (kind: number): boolean => kind >= 20000 && kind < 30000

// Like hoytech::from_hex: optional 0x prefix, any case, even length only.
const fromHex = (input: unknown): Buffer => {
  if (typeof input !== 'string') {
    throw new Error(`Expected a hex string, got ${typeof input}`)
  }

  const hex = input.startsWith('0x') ? input.slice(2) : input

  if (hex.length % 2 !== 0 || !/^[0-9a-f]*$/i.test(hex)) {
    throw new Error(`Invalid hex: ${input}`)
  }

  return Buffer.from(hex, 'hex')
}

const parseExpiration = (value: string): bigint => {
  const expiration = /^\d+$/.test(value) ? BigInt(value) : -1n
  if (expiration < MIN_EXPIRATION || expiration > MAX_UINT64) {
    throw new Error(`Invalid expiration tag: ${value}`)
  }

  return expiration
}

const isUInt53 = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0

export interface PackedEventFields {
  id: Buffer
  pubkey: Buffer
  createdAt: number
  kind: number
  expiration: bigint
  tags: PackedTag[]
}

// Mirrors nostrJsonToPackedEvent in strfry's events.cpp.
export const toPackedEventFields = (event: Event): PackedEventFields => {
  const id = fromHex(event.id)
  const pubkey = fromHex(event.pubkey)
  if (id.length !== 32 || pubkey.length !== 32) {
    throw new Error('Event id and pubkey must be 32 bytes')
  }

  if (!isUInt53(event.created_at) || !isUInt53(event.kind)) {
    throw new Error('Event created_at and kind must be non-negative integers')
  }

  if (!Array.isArray(event.tags)) {
    throw new Error('Event tags must be an array')
  }

  const tags: PackedTag[] = []
  let expiration = 0n

  // strfry adds an empty d tag, first for replaceable kinds and last for parameterized ones.
  if (isReplaceableKind(event.kind)) {
    tags.push({ name: 'd', value: Buffer.alloc(0) })
  }

  for (const tag of event.tags) {
    if (!Array.isArray(tag) || tag.length < 1 || typeof tag[0] !== 'string') {
      throw new Error('Every tag needs a name')
    }

    const name = tag[0]
    const value = tag.length >= 2 ? tag[1] : ''
    if (typeof value !== 'string') {
      throw new Error(`Tag ${name} has a non-string value`)
    }

    if (Buffer.byteLength(name) === 1) {
      let packed: Buffer
      if (name === 'e' || name === 'p') {
        // Length is checked before decoding, so "0x" + 62 hex chars packs to 31 bytes.
        if (Buffer.byteLength(value) !== 64) {
          throw new Error(`Tag ${name} must be 64 hex characters`)
        }
        packed = fromHex(value)
      } else {
        packed = Buffer.from(value)
      }

      if (packed.length <= MAX_PACKED_TAG_VALUE_SIZE) {
        tags.push({ name, value: packed })
      }
    } else if (name === 'expiration' && expiration === 0n) {
      expiration = parseExpiration(value)
    }
  }

  if (isParameterizedReplaceableKind(event.kind)) {
    tags.push({ name: 'd', value: Buffer.alloc(0) })
  }

  if (isEphemeralKind(event.kind)) {
    expiration = EPHEMERAL_EXPIRATION
  }

  return { id, pubkey, createdAt: event.created_at, kind: event.kind, expiration, tags }
}

export const serializePackedEvent = (fields: PackedEventFields): Buffer => {
  if (fields.id.length !== 32 || fields.pubkey.length !== 32) {
    throw new Error('Event id and pubkey must be 32 bytes')
  }

  const header = Buffer.alloc(PACKED_EVENT_HEADER_SIZE)
  fields.id.copy(header, 0)
  fields.pubkey.copy(header, 32)
  header.writeBigUInt64LE(BigInt(fields.createdAt), 64)
  header.writeBigUInt64LE(BigInt(fields.kind), 72)
  header.writeBigUInt64LE(fields.expiration, 80)

  const tags = fields.tags.map(({ name, value }) => {
    if (Buffer.byteLength(name) !== 1 || value.length > MAX_PACKED_TAG_VALUE_SIZE) {
      throw new Error(`Tag ${name} cannot be packed`)
    }

    return Buffer.concat([Buffer.from([name.charCodeAt(0), value.length]), value])
  })

  return Buffer.concat([header, ...tags])
}
