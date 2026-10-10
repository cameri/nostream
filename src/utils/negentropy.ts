// Negentropy (NIP-77) set reconciliation, protocol version 1.
//
// TypeScript port of the reference implementation at https://github.com/hoytech/negentropy
// (js/Negentropy.js), (C) 2023 Doug Hoyte, MIT license. The wire format is unchanged; the port is
// synchronous (server-side only) and bounds-checks all input read from the network.

import { createHash } from 'crypto'

export const NEGENTROPY_PROTOCOL_VERSION = 0x61

const ID_SIZE = 32
const FINGERPRINT_SIZE = 16
const MIN_FRAME_SIZE_LIMIT = 4096
// Headroom left under frameSizeLimit for the trailing fingerprint bound the reference appends.
const FRAME_SIZE_HEADROOM = 200
const BUCKETS = 16
const MAX_VARINT_BYTES = 8

// Sentinel for the "infinity" upper bound. It is encoded as 0 on the wire and never as a number.
export const MAX_TIMESTAMP = Number.MAX_SAFE_INTEGER

enum Mode {
  Skip = 0,
  Fingerprint = 1,
  IdList = 2,
}

export interface NegentropyItem {
  timestamp: number
  id: Uint8Array
}

export interface ReconcileResult {
  // Next message to send to the peer, or null when the initiator has nothing left to send.
  output: Uint8Array | null
  // Hex ids we have and the peer lacks / the peer has and we lack. Only filled in for the initiator.
  haveIds: string[]
  needIds: string[]
}

const toHex = (bytes: Uint8Array): string =>
  Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('hex')

const compareBytes = (a: Uint8Array, b: Uint8Array): number => {
  const shared = Math.min(a.byteLength, b.byteLength)
  for (let i = 0; i < shared; i++) {
    if (a[i] !== b[i]) {
      return a[i] < b[i] ? -1 : 1
    }
  }

  return a.byteLength < b.byteLength ? -1 : a.byteLength > b.byteLength ? 1 : 0
}

const compareItems = (a: NegentropyItem, b: NegentropyItem): number =>
  a.timestamp === b.timestamp ? compareBytes(a.id, b.id) : a.timestamp < b.timestamp ? -1 : 1

const encodeVarInt = (n: number): Uint8Array => {
  if (!Number.isSafeInteger(n) || n < 0) {
    throw new Error('varint out of range')
  }
  if (n === 0) {
    return Uint8Array.of(0)
  }

  const groups: number[] = []
  for (let rest = n; rest > 0; rest = Math.floor(rest / 128)) {
    groups.push(rest % 128)
  }
  groups.reverse()
  for (let i = 0; i < groups.length - 1; i++) {
    groups[i] |= 128
  }

  return Uint8Array.from(groups)
}

class ByteWriter {
  private readonly chunks: Uint8Array[] = []
  private size = 0

  public get length(): number {
    return this.size
  }

  public write(bytes: Uint8Array): void {
    this.chunks.push(bytes)
    this.size += bytes.byteLength
  }

  public writeVarInt(n: number): void {
    this.write(encodeVarInt(n))
  }

  public toBytes(): Uint8Array {
    return Buffer.concat(this.chunks, this.size)
  }
}

class ByteReader {
  private offset = 0

  public constructor(private readonly buffer: Uint8Array) {}

  public get remaining(): number {
    return this.buffer.byteLength - this.offset
  }

  public readByte(): number {
    return this.readBytes(1)[0]
  }

  public readBytes(n: number): Uint8Array {
    if (n > this.remaining) {
      throw new Error('parse ends prematurely')
    }
    const bytes = this.buffer.subarray(this.offset, this.offset + n)
    this.offset += n

    return bytes
  }

  public readVarInt(): number {
    let result = 0
    for (let i = 0; i < MAX_VARINT_BYTES; i++) {
      const byte = this.readByte()
      result = result * 128 + (byte & 127)
      if ((byte & 128) === 0) {
        if (!Number.isSafeInteger(result)) {
          throw new Error('varint out of range')
        }

        return result
      }
    }

    throw new Error('varint too long')
  }
}

export class NegentropyStorageVector {
  private items: NegentropyItem[] = []
  private sealed = false

  public insert(timestamp: number, id: Uint8Array): void {
    if (this.sealed) {
      throw new Error('already sealed')
    }
    if (!Number.isSafeInteger(timestamp) || timestamp < 0 || timestamp >= MAX_TIMESTAMP) {
      throw new Error('bad timestamp for added item')
    }
    if (id.byteLength !== ID_SIZE) {
      throw new Error('bad id size for added item')
    }

    this.items.push({ timestamp, id })
  }

  public seal(): void {
    if (this.sealed) {
      throw new Error('already sealed')
    }

    this.items.sort(compareItems)
    for (let i = 1; i < this.items.length; i++) {
      if (compareItems(this.items[i - 1], this.items[i]) === 0) {
        throw new Error('duplicate item inserted')
      }
    }
    this.sealed = true
  }

  public size(): number {
    this.assertSealed()

    return this.items.length
  }

  public iterate(begin: number, end: number, callback: (item: NegentropyItem, index: number) => boolean): void {
    this.assertSealed()
    this.assertBounds(begin, end)

    for (let i = begin; i < end; i++) {
      if (!callback(this.items[i], i)) {
        break
      }
    }
  }

  // Index of the first item in [begin, end) that is >= bound, or end if there is none.
  public findLowerBound(begin: number, end: number, bound: NegentropyItem): number {
    this.assertSealed()
    this.assertBounds(begin, end)

    let first = begin
    let count = end - begin
    while (count > 0) {
      const step = Math.floor(count / 2)
      const middle = first + step
      if (compareItems(this.items[middle], bound) < 0) {
        first = middle + 1
        count -= step + 1
      } else {
        count = step
      }
    }

    return first
  }

  // Sum of the ids in [begin, end) as a 256-bit little-endian integer mod 2^256, hashed together
  // with the item count; the first 16 bytes of the SHA-256 are the fingerprint.
  public fingerprint(begin: number, end: number): Uint8Array {
    this.assertSealed()
    this.assertBounds(begin, end)

    const sum = new DataView(new ArrayBuffer(ID_SIZE))
    for (let i = begin; i < end; i++) {
      const id = new DataView(this.items[i].id.buffer, this.items[i].id.byteOffset, ID_SIZE)
      let carry = 0
      for (let offset = 0; offset < ID_SIZE; offset += 4) {
        const total = sum.getUint32(offset, true) + id.getUint32(offset, true) + carry
        sum.setUint32(offset, total >>> 0, true)
        carry = total > 0xffffffff ? 1 : 0
      }
    }

    const hash = createHash('sha256')
      .update(new Uint8Array(sum.buffer))
      .update(encodeVarInt(end - begin))
      .digest()

    return hash.subarray(0, FINGERPRINT_SIZE)
  }

  private assertSealed(): void {
    if (!this.sealed) {
      throw new Error('not sealed')
    }
  }

  private assertBounds(begin: number, end: number): void {
    if (begin > end || end > this.items.length) {
      throw new Error('bad range')
    }
  }
}

export class Negentropy {
  private isInitiator = false
  private lastTimestampIn = 0
  private lastTimestampOut = 0

  public constructor(
    private readonly storage: NegentropyStorageVector,
    private readonly frameSizeLimit = 0,
  ) {
    if (frameSizeLimit !== 0 && frameSizeLimit < MIN_FRAME_SIZE_LIMIT) {
      throw new Error('frameSizeLimit too small')
    }
  }

  // Client side only: builds the first message of a session.
  public initiate(): Uint8Array {
    if (this.isInitiator) {
      throw new Error('already initiated')
    }
    this.isInitiator = true
    this.resetTimestamps()

    const output = new ByteWriter()
    output.write(Uint8Array.of(NEGENTROPY_PROTOCOL_VERSION))
    this.splitRange(0, this.storage.size(), { timestamp: MAX_TIMESTAMP, id: new Uint8Array(0) }, output)

    return output.toBytes()
  }

  public reconcile(message: Uint8Array): ReconcileResult {
    const haveIds: string[] = []
    const needIds: string[] = []
    const query = new ByteReader(message)

    // Timestamps are delta-encoded per message.
    this.resetTimestamps()

    const fullOutput = new ByteWriter()
    fullOutput.write(Uint8Array.of(NEGENTROPY_PROTOCOL_VERSION))

    const protocolVersion = query.readByte()
    if (protocolVersion < 0x60 || protocolVersion > 0x6f) {
      throw new Error('invalid negentropy protocol version byte')
    }
    if (protocolVersion !== NEGENTROPY_PROTOCOL_VERSION) {
      if (this.isInitiator) {
        throw new Error(`unsupported negentropy protocol version requested: ${protocolVersion - 0x60}`)
      }

      // Tell the peer which version we speak and let it retry.
      return { output: fullOutput.toBytes(), haveIds, needIds }
    }

    const storageSize = this.storage.size()
    let prevBound: NegentropyItem = { timestamp: 0, id: new Uint8Array(0) }
    let prevIndex = 0
    let skip = false

    while (query.remaining !== 0) {
      let o = new ByteWriter()

      const doSkip = () => {
        if (skip) {
          skip = false
          this.encodeBound(prevBound, o)
          o.writeVarInt(Mode.Skip)
        }
      }

      const currBound = this.decodeBound(query)
      const mode = query.readVarInt()

      const lower = prevIndex
      let upper = this.storage.findLowerBound(prevIndex, storageSize, currBound)

      if (mode === Mode.Skip) {
        skip = true
      } else if (mode === Mode.Fingerprint) {
        const theirFingerprint = query.readBytes(FINGERPRINT_SIZE)
        const ourFingerprint = this.storage.fingerprint(lower, upper)

        if (compareBytes(theirFingerprint, ourFingerprint) !== 0) {
          doSkip()
          this.splitRange(lower, upper, currBound, o)
        } else {
          skip = true
        }
      } else if (mode === Mode.IdList) {
        const numIds = query.readVarInt()
        if (numIds * ID_SIZE > query.remaining) {
          throw new Error('parse ends prematurely')
        }

        const theirIds = new Map<string, Uint8Array>()
        for (let i = 0; i < numIds; i++) {
          const id = query.readBytes(ID_SIZE)
          if (this.isInitiator) {
            theirIds.set(toHex(id), id)
          }
        }

        if (this.isInitiator) {
          skip = true

          this.storage.iterate(lower, upper, (item) => {
            const key = toHex(item.id)
            if (theirIds.has(key)) {
              theirIds.delete(key)
            } else {
              haveIds.push(key)
            }

            return true
          })

          for (const key of theirIds.keys()) {
            needIds.push(key)
          }
        } else {
          doSkip()

          const responseIds = new ByteWriter()
          let numResponseIds = 0
          let endBound = currBound

          this.storage.iterate(lower, upper, (item, index) => {
            if (this.exceededFrameSizeLimit(fullOutput.length + responseIds.length)) {
              endBound = item
              // Shrink upper so the remaining range gets the correct fingerprint below.
              upper = index
              return false
            }

            responseIds.write(item.id)
            numResponseIds++
            return true
          })

          this.encodeBound(endBound, o)
          o.writeVarInt(Mode.IdList)
          o.writeVarInt(numResponseIds)
          o.write(responseIds.toBytes())

          fullOutput.write(o.toBytes())
          o = new ByteWriter()
        }
      } else {
        throw new Error('unexpected mode')
      }

      if (this.exceededFrameSizeLimit(fullOutput.length + o.length)) {
        // Stop range processing and answer with one fingerprint covering everything that is left.
        const remainingFingerprint = this.storage.fingerprint(upper, storageSize)

        this.encodeBound({ timestamp: MAX_TIMESTAMP, id: new Uint8Array(0) }, fullOutput)
        fullOutput.writeVarInt(Mode.Fingerprint)
        fullOutput.write(remainingFingerprint)
        break
      }

      fullOutput.write(o.toBytes())

      prevIndex = upper
      prevBound = currBound
    }

    return {
      output: fullOutput.length === 1 && this.isInitiator ? null : fullOutput.toBytes(),
      haveIds,
      needIds,
    }
  }

  private splitRange(lower: number, upper: number, upperBound: NegentropyItem, o: ByteWriter): void {
    const numElems = upper - lower

    if (numElems < BUCKETS * 2) {
      this.encodeBound(upperBound, o)
      o.writeVarInt(Mode.IdList)
      o.writeVarInt(numElems)
      this.storage.iterate(lower, upper, (item) => {
        o.write(item.id)
        return true
      })

      return
    }

    const itemsPerBucket = Math.floor(numElems / BUCKETS)
    const bucketsWithExtra = numElems % BUCKETS
    let curr = lower

    for (let i = 0; i < BUCKETS; i++) {
      const bucketSize = itemsPerBucket + (i < bucketsWithExtra ? 1 : 0)
      const ourFingerprint = this.storage.fingerprint(curr, curr + bucketSize)
      curr += bucketSize

      let nextBound: NegentropyItem
      if (curr === upper) {
        nextBound = upperBound
      } else {
        let prevItem: NegentropyItem | undefined
        let currItem: NegentropyItem | undefined
        this.storage.iterate(curr - 1, curr + 1, (item, index) => {
          if (index === curr - 1) {
            prevItem = item
          } else {
            currItem = item
          }

          return true
        })

        nextBound = this.getMinimalBound(prevItem as NegentropyItem, currItem as NegentropyItem)
      }

      this.encodeBound(nextBound, o)
      o.writeVarInt(Mode.Fingerprint)
      o.write(ourFingerprint)
    }
  }

  private exceededFrameSizeLimit(size: number): boolean {
    return this.frameSizeLimit !== 0 && size > this.frameSizeLimit - FRAME_SIZE_HEADROOM
  }

  private resetTimestamps(): void {
    this.lastTimestampIn = 0
    this.lastTimestampOut = 0
  }

  private decodeTimestampIn(reader: ByteReader): number {
    const encoded = reader.readVarInt()
    if (encoded === 0 || this.lastTimestampIn === MAX_TIMESTAMP) {
      this.lastTimestampIn = MAX_TIMESTAMP
      return MAX_TIMESTAMP
    }

    const timestamp = encoded - 1 + this.lastTimestampIn
    if (!Number.isSafeInteger(timestamp) || timestamp >= MAX_TIMESTAMP) {
      throw new Error('timestamp out of range')
    }
    this.lastTimestampIn = timestamp

    return timestamp
  }

  private decodeBound(reader: ByteReader): NegentropyItem {
    const timestamp = this.decodeTimestampIn(reader)
    const length = reader.readVarInt()
    if (length > ID_SIZE) {
      throw new Error('bound key too long')
    }

    return { timestamp, id: reader.readBytes(length) }
  }

  private encodeBound(bound: NegentropyItem, o: ByteWriter): void {
    if (bound.timestamp === MAX_TIMESTAMP) {
      this.lastTimestampOut = MAX_TIMESTAMP
      o.writeVarInt(0)
    } else {
      o.writeVarInt(bound.timestamp - this.lastTimestampOut + 1)
      this.lastTimestampOut = bound.timestamp
    }

    o.writeVarInt(bound.id.byteLength)
    o.write(bound.id)
  }

  // The shortest bound that still sorts after prev and at-or-before curr.
  private getMinimalBound(prev: NegentropyItem, curr: NegentropyItem): NegentropyItem {
    if (curr.timestamp !== prev.timestamp) {
      return { timestamp: curr.timestamp, id: new Uint8Array(0) }
    }

    let sharedPrefixBytes = 0
    while (sharedPrefixBytes < ID_SIZE && curr.id[sharedPrefixBytes] === prev.id[sharedPrefixBytes]) {
      sharedPrefixBytes++
    }

    return { timestamp: curr.timestamp, id: curr.id.subarray(0, sharedPrefixBytes + 1) }
  }
}
