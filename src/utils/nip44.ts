import * as secp256k1 from '@noble/secp256k1'
import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from 'crypto'

const MIN_PLAINTEXT_SIZE = 1
const MAX_PLAINTEXT_SIZE = 65535

// HKDF-extract: PRK = HMAC-SHA256(salt, IKM)
function hkdfExtract(salt: Buffer, ikm: Buffer): Buffer {
  return createHmac('sha256', salt).update(ikm).digest()
}

// HKDF-expand: OKM = T(1) || T(2) || ... where T(n) = HMAC-SHA256(PRK, T(n-1) || info || n)
function hkdfExpand(prk: Buffer, info: Buffer, length: number): Buffer {
  const hashLen = 32
  const n = Math.ceil(length / hashLen)
  const okm = Buffer.alloc(n * hashLen)
  let prev = Buffer.alloc(0)

  for (let i = 1; i <= n; i++) {
    const hmac = createHmac('sha256', prk)
    hmac.update(prev)
    hmac.update(info)
    hmac.update(Buffer.from([i]))
    prev = hmac.digest()
    prev.copy(okm, (i - 1) * hashLen)
  }

  return okm.subarray(0, length)
}

/**
 * Derive a conversation key from a sender private key and recipient public key.
 * conversation_key = HKDF-extract(IKM=shared_x, salt='nip44-v2')
 * Result is the same regardless of which party computes it: conv(a, B) == conv(b, A)
 */
export function getConversationKey(privateKeyHex: string, publicKeyHex: string): Buffer {
  // ECDH: unhashed 32-byte x coordinate of the shared point
  const shared = secp256k1.getSharedSecret(privateKeyHex, `02${publicKeyHex}`, true)
  const sharedX = Buffer.from(shared).subarray(1) // strip 0x02 prefix

  return hkdfExtract(Buffer.from('nip44-v2'), sharedX)
}

function getMessageKeys(
  conversationKey: Buffer,
  nonce: Buffer,
): { chachaKey: Buffer; chachaNonce: Buffer; hmacKey: Buffer } {
  if (conversationKey.length !== 32) {
    throw new Error('invalid conversation_key length')
  }
  if (nonce.length !== 32) {
    throw new Error('invalid nonce length')
  }

  const keys = hkdfExpand(conversationKey, nonce, 76)
  return {
    chachaKey: keys.subarray(0, 32),
    chachaNonce: keys.subarray(32, 44),
    hmacKey: keys.subarray(44, 76),
  }
}

function calcPaddedLen(unpaddedLen: number): number {
  if (unpaddedLen <= 32) {
    return 32
  }
  const nextPower = 1 << (Math.floor(Math.log2(unpaddedLen - 1)) + 1)
  const chunk = nextPower <= 256 ? 32 : nextPower / 8
  return chunk * (Math.floor((unpaddedLen - 1) / chunk) + 1)
}

function pad(plaintext: string): Buffer {
  const unpadded = Buffer.from(plaintext, 'utf8')
  const unpaddedLen = unpadded.length
  if (unpaddedLen < MIN_PLAINTEXT_SIZE || unpaddedLen > MAX_PLAINTEXT_SIZE) {
    throw new Error('invalid plaintext length')
  }
  const prefix = Buffer.alloc(2)
  prefix.writeUInt16BE(unpaddedLen, 0)
  const suffix = Buffer.alloc(calcPaddedLen(unpaddedLen) - unpaddedLen)
  return Buffer.concat([prefix, unpadded, suffix])
}

function unpad(padded: Buffer): string {
  const unpaddedLen = padded.readUInt16BE(0)
  const unpadded = padded.subarray(2, 2 + unpaddedLen)
  if (unpaddedLen === 0 || unpadded.length !== unpaddedLen || padded.length !== 2 + calcPaddedLen(unpaddedLen)) {
    throw new Error('invalid padding')
  }
  return unpadded.toString('utf8')
}

/**
 * Encrypt plaintext using NIP-44 v2.
 * Output format: base64(0x02 || nonce[32] || ciphertext || mac[32])
 */
export function nip44Encrypt(plaintext: string, conversationKey: Buffer, nonce: Buffer = randomBytes(32)): string {
  const { chachaKey, chachaNonce, hmacKey } = getMessageKeys(conversationKey, nonce)
  const padded = pad(plaintext)

  // ChaCha20: OpenSSL expects a 16-byte IV = [counter_le32=0][nonce_96bit]
  const iv = Buffer.concat([Buffer.alloc(4), chachaNonce])
  const cipher = createCipheriv('chacha20', chachaKey, iv)
  const ciphertext = Buffer.concat([cipher.update(padded), cipher.final()])

  // MAC = HMAC-SHA256(hmacKey, nonce || ciphertext)
  const mac = createHmac('sha256', hmacKey).update(nonce).update(ciphertext).digest()

  return Buffer.concat([Buffer.from([0x02]), nonce, ciphertext, mac]).toString('base64')
}

/**
 * Decrypt a NIP-44 v2 payload.
 * Validates version byte, payload sizes, and MAC before decrypting.
 */
export function nip44Decrypt(payload: string, conversationKey: Buffer): string {
  if (!payload || payload[0] === '#') {
    throw new Error('unknown version')
  }
  if (payload.length < 132 || payload.length > 87472) {
    throw new Error('invalid payload size')
  }

  const data = Buffer.from(payload, 'base64')
  if (data.length < 99 || data.length > 65603) {
    throw new Error('invalid data size')
  }

  const version = data[0]
  if (version !== 2) {
    throw new Error(`unknown version ${version}`)
  }

  const nonce = data.subarray(1, 33)
  const ciphertext = data.subarray(33, data.length - 32)
  const mac = data.subarray(data.length - 32)

  const { chachaKey, chachaNonce, hmacKey } = getMessageKeys(conversationKey, nonce)

  const expectedMac = createHmac('sha256', hmacKey).update(nonce).update(ciphertext).digest()
  if (!timingSafeEqual(expectedMac, mac)) {
    throw new Error('invalid MAC')
  }

  const iv = Buffer.concat([Buffer.alloc(4), chachaNonce])
  const decipher = createDecipheriv('chacha20', chachaKey, iv)
  const padded = Buffer.concat([decipher.update(ciphertext), decipher.final()])

  return unpad(padded)
}

/**
 * Validate the structural format of a NIP-44 v2 payload without decrypting it.
 * Returns an error string if invalid, or undefined if the format looks valid.
 */
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/

export function validateNip44Payload(payload: string): string | undefined {
  if (!payload || payload[0] === '#') {
    return 'unsupported encryption version'
  }
  if (payload.length < 132 || payload.length > 87472) {
    return 'invalid payload size'
  }

  if (payload.length % 4 !== 0 || !BASE64_RE.test(payload)) {
    return 'payload is not valid base64'
  }

  const data = Buffer.from(payload, 'base64')

  if (data.length < 99 || data.length > 65603) {
    return 'invalid decoded payload size'
  }
  if (data[0] !== 2) {
    return `unsupported encryption version ${data[0]}`
  }

  return undefined
}
