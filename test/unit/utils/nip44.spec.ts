import * as secp256k1 from '@noble/secp256k1'
import { expect } from 'chai'

import { getConversationKey, nip44Decrypt, nip44Encrypt, validateNip44Payload } from '../../../src/utils/nip44'

// ---------------------------------------------------------------------------
// Helpers — compute pub from sec using the same library the relay uses
// ---------------------------------------------------------------------------

function pubkeyFromPrivkey(secHex: string): string {
  return Buffer.from(secp256k1.getPublicKey(secHex, true)).subarray(1).toString('hex')
}

// ---------------------------------------------------------------------------
// Published test vector from the NIP-44 spec
// sec1: 000...001  sec2: 000...002
// ---------------------------------------------------------------------------

const SEC1 = '0000000000000000000000000000000000000000000000000000000000000001'
const SEC2 = '0000000000000000000000000000000000000000000000000000000000000002'
const SEC3 = '0000000000000000000000000000000000000000000000000000000000000003'
const KNOWN_CONVERSATION_KEY = 'c41c775356fd92eadc63ff5a0dc1da211b268cbea22316767095b2871ea1412d'
const KNOWN_NONCE = '0000000000000000000000000000000000000000000000000000000000000001'
const KNOWN_PLAINTEXT = 'a'
const KNOWN_PAYLOAD =
  'AgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABee0G5VSK0/9YypIObAtDKfYEAjD35uVkHyB0F4DwrcNaCXlCWZKaArsGrY6M9wnuTMxWfp1RTN9Xga8no+kF5Vsb'

let PUB1: string
let PUB2: string
let PUB3: string
let CONVERSATION_KEY: Buffer
let RECIPIENT_CONVERSATION_KEY: Buffer
let DIFFERENT_CONVERSATION_KEY: Buffer

// ---------------------------------------------------------------------------

describe('NIP-44', () => {
  before(() => {
    PUB1 = pubkeyFromPrivkey(SEC1)
    PUB2 = pubkeyFromPrivkey(SEC2)
    PUB3 = pubkeyFromPrivkey(SEC3)
    CONVERSATION_KEY = getConversationKey(SEC1, PUB2)
    RECIPIENT_CONVERSATION_KEY = getConversationKey(SEC2, PUB1)
    DIFFERENT_CONVERSATION_KEY = getConversationKey(SEC1, PUB3)
  })

  describe('getConversationKey', () => {
    it('derives the correct conversation key from sec1 and pub2', () => {
      expect(CONVERSATION_KEY.toString('hex')).to.equal(KNOWN_CONVERSATION_KEY)
    })

    it('is symmetric: conv(a, B) == conv(b, A)', () => {
      expect(CONVERSATION_KEY.toString('hex')).to.equal(RECIPIENT_CONVERSATION_KEY.toString('hex'))
    })

    it('produces different keys for different key pairs', () => {
      expect(CONVERSATION_KEY.toString('hex')).to.not.equal(DIFFERENT_CONVERSATION_KEY.toString('hex'))
    })
  })

  describe('nip44Encrypt', () => {
    it('produces the canonical payload from the NIP-44 spec test vector', () => {
      const nonce = Buffer.from(KNOWN_NONCE, 'hex')

      const payload = nip44Encrypt(KNOWN_PLAINTEXT, CONVERSATION_KEY, nonce)
      expect(payload).to.equal(KNOWN_PAYLOAD)
    })

    it('produces a valid base64 string starting with version byte 0x02', () => {
      const payload = nip44Encrypt('hello', CONVERSATION_KEY)
      const decoded = Buffer.from(payload, 'base64')

      expect(decoded[0]).to.equal(2) // version byte
      expect(payload.length).to.be.within(132, 87472)
    })

    it('produces different ciphertexts for the same plaintext (random nonce)', () => {
      const payload1 = nip44Encrypt('same message', CONVERSATION_KEY)
      const payload2 = nip44Encrypt('same message', CONVERSATION_KEY)

      expect(payload1).to.not.equal(payload2)
    })

    it('throws for empty plaintext', () => {
      expect(() => nip44Encrypt('', CONVERSATION_KEY)).to.throw('invalid plaintext length')
    })

    it('throws for plaintext exceeding 65535 bytes', () => {
      expect(() => nip44Encrypt('x'.repeat(65536), CONVERSATION_KEY)).to.throw('invalid plaintext length')
    })
  })

  describe('nip44Decrypt', () => {
    it('decrypts the canonical NIP-44 spec test vector', () => {
      const plaintext = nip44Decrypt(KNOWN_PAYLOAD, CONVERSATION_KEY)
      expect(plaintext).to.equal(KNOWN_PLAINTEXT)
    })

    it('round-trips any plaintext through encrypt then decrypt', () => {
      const original = 'Hola, que tal? 🌍'

      const payload = nip44Encrypt(original, CONVERSATION_KEY)
      const recovered = nip44Decrypt(payload, CONVERSATION_KEY)

      expect(recovered).to.equal(original)
    })

    it('works with the symmetric key (recipient decrypts sender message)', () => {
      const payload = nip44Encrypt('secret message', CONVERSATION_KEY)
      const plaintext = nip44Decrypt(payload, RECIPIENT_CONVERSATION_KEY)

      expect(plaintext).to.equal('secret message')
    })

    it('throws when MAC is tampered', () => {
      const payload = nip44Encrypt('tamper me', CONVERSATION_KEY)

      // Flip the last character of the base64 payload to corrupt the MAC
      const tampered = payload.slice(0, -4) + 'AAAA'

      expect(() => nip44Decrypt(tampered, CONVERSATION_KEY)).to.throw()
    })

    it('throws for payload starting with # (unsupported future version)', () => {
      expect(() => nip44Decrypt('#not-base64', CONVERSATION_KEY)).to.throw('unknown version')
    })

    it('throws for payload that is too short', () => {
      expect(() => nip44Decrypt('dG9vc2hvcnQ=', CONVERSATION_KEY)).to.throw('invalid payload size')
    })

    it('throws for wrong conversation key', () => {
      const payload = nip44Encrypt('private', CONVERSATION_KEY)

      expect(() => nip44Decrypt(payload, DIFFERENT_CONVERSATION_KEY)).to.throw()
    })
  })

  describe('validateNip44Payload', () => {
    it('returns undefined for a valid NIP-44 v2 payload', () => {
      expect(validateNip44Payload(KNOWN_PAYLOAD)).to.be.undefined
    })

    it('returns undefined for a freshly encrypted payload', () => {
      const payload = nip44Encrypt('hello', CONVERSATION_KEY)

      expect(validateNip44Payload(payload)).to.be.undefined
    })

    it('returns error string for payload starting with #', () => {
      expect(validateNip44Payload('#unsupported')).to.be.a('string')
    })

    it('returns error string for empty string', () => {
      expect(validateNip44Payload('')).to.be.a('string')
    })

    it('returns error string for payload that is too short', () => {
      expect(validateNip44Payload('dG9vc2hvcnQ=')).to.be.a('string')
    })

    it('returns error string for payload that is too long', () => {
      expect(validateNip44Payload('A'.repeat(87473))).to.be.a('string')
    })

    it('returns error string when version byte is not 0x02', () => {
      // Build a fake payload: version=0x01 + 32-byte nonce + 34-byte ciphertext + 32-byte mac = 99 bytes
      const fakeData = Buffer.alloc(99)
      fakeData[0] = 0x01 // wrong version
      const payload = fakeData.toString('base64')

      expect(validateNip44Payload(payload)).to.include('unsupported encryption version')
    })
  })

  describe('padding length (calc_padded_len)', () => {
    // Test via the encrypt/decrypt round-trip: the padded buffer length is observable
    // from the output size. Direct cases from the NIP-44 spec.

    const cases: [number, number][] = [
      [1, 32],
      [32, 32],
      [33, 64],
      [64, 64],
      [65, 96],
      [100, 128],
      [256, 256],
      [257, 320],
      [512, 512],
      [1024, 1024],
    ]

    for (const [unpaddedLen, expectedPaddedLen] of cases) {
      it(`pads ${unpaddedLen} bytes to ${expectedPaddedLen} bytes`, () => {
        const plaintext = 'a'.repeat(unpaddedLen)

        const payload = nip44Encrypt(plaintext, CONVERSATION_KEY)
        const decoded = Buffer.from(payload, 'base64')

        // Layout: 1 (version) + 32 (nonce) + paddedLen + 2 (length prefix) + 32 (mac)
        const paddedWithPrefix = decoded.length - 1 - 32 - 32
        // paddedWithPrefix = 2 (u16 prefix) + expectedPaddedLen
        expect(paddedWithPrefix).to.equal(expectedPaddedLen + 2)
      })
    }
  })
})
