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
const KNOWN_CONVERSATION_KEY = 'c41c775356fd92eadc63ff5a0dc1da211b268cbea22316767095b2871ea1412d'
const KNOWN_NONCE = '0000000000000000000000000000000000000000000000000000000000000001'
const KNOWN_PLAINTEXT = 'a'
const KNOWN_PAYLOAD =
  'AgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABee0G5VSK0/9YypIObAtDKfYEAjD35uVkHyB0F4DwrcNaCXlCWZKaArsGrY6M9wnuTMxWfp1RTN9Xga8no+kF5Vsb'

// ---------------------------------------------------------------------------

describe('NIP-44', () => {
  describe('getConversationKey', () => {
    it('derives the correct conversation key from sec1 and pub2', () => {
      const pub2 = pubkeyFromPrivkey(SEC2)
      const key = getConversationKey(SEC1, pub2)
      expect(key.toString('hex')).to.equal(KNOWN_CONVERSATION_KEY)
    })

    it('is symmetric: conv(a, B) == conv(b, A)', () => {
      const pub1 = pubkeyFromPrivkey(SEC1)
      const pub2 = pubkeyFromPrivkey(SEC2)
      const keyAB = getConversationKey(SEC1, pub2)
      const keyBA = getConversationKey(SEC2, pub1)
      expect(keyAB.toString('hex')).to.equal(keyBA.toString('hex'))
    })

    it('produces different keys for different key pairs', () => {
      const sec3 = '0000000000000000000000000000000000000000000000000000000000000003'
      const pub2 = pubkeyFromPrivkey(SEC2)
      const pub3 = pubkeyFromPrivkey(sec3)
      const key12 = getConversationKey(SEC1, pub2)
      const key13 = getConversationKey(SEC1, pub3)
      expect(key12.toString('hex')).to.not.equal(key13.toString('hex'))
    })
  })

  describe('nip44Encrypt', () => {
    it('produces the canonical payload from the NIP-44 spec test vector', () => {
      const pub2 = pubkeyFromPrivkey(SEC2)
      const conversationKey = getConversationKey(SEC1, pub2)
      const nonce = Buffer.from(KNOWN_NONCE, 'hex')

      const payload = nip44Encrypt(KNOWN_PLAINTEXT, conversationKey, nonce)
      expect(payload).to.equal(KNOWN_PAYLOAD)
    })

    it('produces a valid base64 string starting with version byte 0x02', () => {
      const pub2 = pubkeyFromPrivkey(SEC2)
      const conversationKey = getConversationKey(SEC1, pub2)

      const payload = nip44Encrypt('hello', conversationKey)
      const decoded = Buffer.from(payload, 'base64')

      expect(decoded[0]).to.equal(2) // version byte
      expect(payload.length).to.be.within(132, 87472)
    })

    it('produces different ciphertexts for the same plaintext (random nonce)', () => {
      const pub2 = pubkeyFromPrivkey(SEC2)
      const conversationKey = getConversationKey(SEC1, pub2)

      const payload1 = nip44Encrypt('same message', conversationKey)
      const payload2 = nip44Encrypt('same message', conversationKey)

      expect(payload1).to.not.equal(payload2)
    })

    it('throws for empty plaintext', () => {
      const pub2 = pubkeyFromPrivkey(SEC2)
      const conversationKey = getConversationKey(SEC1, pub2)

      expect(() => nip44Encrypt('', conversationKey)).to.throw('invalid plaintext length')
    })

    it('throws for plaintext exceeding 65535 bytes', () => {
      const pub2 = pubkeyFromPrivkey(SEC2)
      const conversationKey = getConversationKey(SEC1, pub2)

      expect(() => nip44Encrypt('x'.repeat(65536), conversationKey)).to.throw('invalid plaintext length')
    })
  })

  describe('nip44Decrypt', () => {
    it('decrypts the canonical NIP-44 spec test vector', () => {
      const pub2 = pubkeyFromPrivkey(SEC2)
      const conversationKey = getConversationKey(SEC1, pub2)

      const plaintext = nip44Decrypt(KNOWN_PAYLOAD, conversationKey)
      expect(plaintext).to.equal(KNOWN_PLAINTEXT)
    })

    it('round-trips any plaintext through encrypt then decrypt', () => {
      const pub2 = pubkeyFromPrivkey(SEC2)
      const conversationKey = getConversationKey(SEC1, pub2)
      const original = 'Hola, que tal? 🌍'

      const payload = nip44Encrypt(original, conversationKey)
      const recovered = nip44Decrypt(payload, conversationKey)

      expect(recovered).to.equal(original)
    })

    it('works with the symmetric key (recipient decrypts sender message)', () => {
      const pub1 = pubkeyFromPrivkey(SEC1)
      const pub2 = pubkeyFromPrivkey(SEC2)

      const senderKey = getConversationKey(SEC1, pub2)
      const recipientKey = getConversationKey(SEC2, pub1)

      const payload = nip44Encrypt('secret message', senderKey)
      const plaintext = nip44Decrypt(payload, recipientKey)

      expect(plaintext).to.equal('secret message')
    })

    it('throws when MAC is tampered', () => {
      const pub2 = pubkeyFromPrivkey(SEC2)
      const conversationKey = getConversationKey(SEC1, pub2)
      const payload = nip44Encrypt('tamper me', conversationKey)

      // Flip the last character of the base64 payload to corrupt the MAC
      const tampered = payload.slice(0, -4) + 'AAAA'

      expect(() => nip44Decrypt(tampered, conversationKey)).to.throw()
    })

    it('throws for payload starting with # (unsupported future version)', () => {
      const pub2 = pubkeyFromPrivkey(SEC2)
      const conversationKey = getConversationKey(SEC1, pub2)

      expect(() => nip44Decrypt('#not-base64', conversationKey)).to.throw('unknown version')
    })

    it('throws for payload that is too short', () => {
      const pub2 = pubkeyFromPrivkey(SEC2)
      const conversationKey = getConversationKey(SEC1, pub2)

      expect(() => nip44Decrypt('dG9vc2hvcnQ=', conversationKey)).to.throw('invalid payload size')
    })

    it('throws for wrong conversation key', () => {
      const sec3 = '0000000000000000000000000000000000000000000000000000000000000003'
      const pub2 = pubkeyFromPrivkey(SEC2)
      const pub3 = pubkeyFromPrivkey(sec3)

      const senderKey = getConversationKey(SEC1, pub2)
      const wrongKey = getConversationKey(SEC1, pub3)

      const payload = nip44Encrypt('private', senderKey)

      expect(() => nip44Decrypt(payload, wrongKey)).to.throw()
    })
  })

  describe('validateNip44Payload', () => {
    it('returns undefined for a valid NIP-44 v2 payload', () => {
      expect(validateNip44Payload(KNOWN_PAYLOAD)).to.be.undefined
    })

    it('returns undefined for a freshly encrypted payload', () => {
      const pub2 = pubkeyFromPrivkey(SEC2)
      const conversationKey = getConversationKey(SEC1, pub2)
      const payload = nip44Encrypt('hello', conversationKey)

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
        const pub2 = pubkeyFromPrivkey(SEC2)
        const conversationKey = getConversationKey(SEC1, pub2)
        const plaintext = 'a'.repeat(unpaddedLen)

        const payload = nip44Encrypt(plaintext, conversationKey)
        const decoded = Buffer.from(payload, 'base64')

        // Layout: 1 (version) + 32 (nonce) + paddedLen + 2 (length prefix) + 32 (mac)
        const paddedWithPrefix = decoded.length - 1 - 32 - 32
        // paddedWithPrefix = 2 (u16 prefix) + expectedPaddedLen
        expect(paddedWithPrefix).to.equal(expectedPaddedLen + 2)
      })
    }
  })
})
