import chai from 'chai'

import { extractNip05FromEvent, isDomainAllowed, parseNip05Identifier } from '../../../src/utils/nip05'
import { Event } from '../../../src/@types/event'
import { EventKinds } from '../../../src/constants/base'

const { expect } = chai

describe('NIP-05 utils', () => {
  describe('parseNip05Identifier', () => {
    it('returns parsed identifier for valid input', () => {
      const result = parseNip05Identifier('user@example.com')
      expect(result).to.deep.equal({ localPart: 'user', domain: 'example.com' })
    })

    it('handles underscores in local part', () => {
      const result = parseNip05Identifier('_@example.com')
      expect(result).to.deep.equal({ localPart: '_', domain: 'example.com' })
    })

    it('lowercases domain and local part', () => {
      const result = parseNip05Identifier('User@Example.COM')
      expect(result).to.deep.equal({ localPart: 'user', domain: 'example.com' })
    })

    it('handles subdomains', () => {
      const result = parseNip05Identifier('alice@relay.example.co.uk')
      expect(result).to.deep.equal({ localPart: 'alice', domain: 'relay.example.co.uk' })
    })

    it('returns undefined for empty string', () => {
      expect(parseNip05Identifier('')).to.be.undefined
    })

    it('returns undefined for null input', () => {
      expect(parseNip05Identifier(null as any)).to.be.undefined
    })

    it('returns undefined for non-string input', () => {
      expect(parseNip05Identifier(123 as any)).to.be.undefined
    })

    it('returns undefined for missing @', () => {
      expect(parseNip05Identifier('userexample.com')).to.be.undefined
    })

    it('returns undefined for missing local part', () => {
      expect(parseNip05Identifier('@example.com')).to.be.undefined
    })

    it('returns undefined for missing domain', () => {
      expect(parseNip05Identifier('user@')).to.be.undefined
    })

    it('returns undefined for invalid domain', () => {
      expect(parseNip05Identifier('user@.com')).to.be.undefined
    })

    it('returns undefined for domain without TLD', () => {
      expect(parseNip05Identifier('user@localhost')).to.be.undefined
    })
  })

  describe('extractNip05FromEvent', () => {
    it('extracts nip05 from kind 0 event', () => {
      const event: Event = {
        id: 'a'.repeat(64),
        pubkey: 'b'.repeat(64),
        created_at: 1234567890,
        kind: EventKinds.SET_METADATA,
        tags: [],
        content: JSON.stringify({ name: 'alice', nip05: 'alice@example.com' }),
        sig: 'c'.repeat(128),
      }
      expect(extractNip05FromEvent(event)).to.equal('alice@example.com')
    })

    it('returns undefined for non-kind-0 event', () => {
      const event: Event = {
        id: 'a'.repeat(64),
        pubkey: 'b'.repeat(64),
        created_at: 1234567890,
        kind: EventKinds.TEXT_NOTE,
        tags: [],
        content: JSON.stringify({ nip05: 'alice@example.com' }),
        sig: 'c'.repeat(128),
      }
      expect(extractNip05FromEvent(event)).to.be.undefined
    })

    it('returns undefined when nip05 is not in content', () => {
      const event: Event = {
        id: 'a'.repeat(64),
        pubkey: 'b'.repeat(64),
        created_at: 1234567890,
        kind: EventKinds.SET_METADATA,
        tags: [],
        content: JSON.stringify({ name: 'alice' }),
        sig: 'c'.repeat(128),
      }
      expect(extractNip05FromEvent(event)).to.be.undefined
    })

    it('returns undefined for invalid JSON content', () => {
      const event: Event = {
        id: 'a'.repeat(64),
        pubkey: 'b'.repeat(64),
        created_at: 1234567890,
        kind: EventKinds.SET_METADATA,
        tags: [],
        content: 'not json',
        sig: 'c'.repeat(128),
      }
      expect(extractNip05FromEvent(event)).to.be.undefined
    })

    it('returns undefined when nip05 is empty string', () => {
      const event: Event = {
        id: 'a'.repeat(64),
        pubkey: 'b'.repeat(64),
        created_at: 1234567890,
        kind: EventKinds.SET_METADATA,
        tags: [],
        content: JSON.stringify({ nip05: '' }),
        sig: 'c'.repeat(128),
      }
      expect(extractNip05FromEvent(event)).to.be.undefined
    })

    it('returns undefined when nip05 is not a string', () => {
      const event: Event = {
        id: 'a'.repeat(64),
        pubkey: 'b'.repeat(64),
        created_at: 1234567890,
        kind: EventKinds.SET_METADATA,
        tags: [],
        content: JSON.stringify({ nip05: 42 }),
        sig: 'c'.repeat(128),
      }
      expect(extractNip05FromEvent(event)).to.be.undefined
    })
  })

  describe('isDomainAllowed', () => {
    it('returns true with no whitelist or blacklist', () => {
      expect(isDomainAllowed('example.com')).to.be.true
    })

    it('returns true with empty whitelist and blacklist', () => {
      expect(isDomainAllowed('example.com', [], [])).to.be.true
    })

    it('returns true if domain is in whitelist', () => {
      expect(isDomainAllowed('example.com', ['example.com'])).to.be.true
    })

    it('returns false if domain is not in whitelist', () => {
      expect(isDomainAllowed('other.com', ['example.com'])).to.be.false
    })

    it('returns false if domain is in blacklist', () => {
      expect(isDomainAllowed('spam.com', undefined, ['spam.com'])).to.be.false
    })

    it('returns true if domain is not in blacklist', () => {
      expect(isDomainAllowed('example.com', undefined, ['spam.com'])).to.be.true
    })

    it('is case-insensitive', () => {
      expect(isDomainAllowed('Example.COM', ['example.com'])).to.be.true
      expect(isDomainAllowed('SPAM.com', undefined, ['spam.COM'])).to.be.false
    })

    it('blacklist takes precedence over whitelist', () => {
      expect(isDomainAllowed('example.com', ['example.com'], ['example.com'])).to.be.false
    })
  })
})
