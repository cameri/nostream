import axios from 'axios'
import chai from 'chai'
import chaiAsPromised from 'chai-as-promised'
import Sinon from 'sinon'
import sinonChai from 'sinon-chai'

chai.use(chaiAsPromised)
chai.use(sinonChai)

import {
  extractNip05FromEvent,
  isDomainAllowed,
  parseNip05Identifier,
  verifyNip05Identifier,
} from '../../../src/utils/nip05'
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

  describe('verifyNip05Identifier', () => {
    let axiosGetStub: Sinon.SinonStub
    const pubkey = 'a'.repeat(64)

    beforeEach(() => {
      axiosGetStub = Sinon.stub(axios, 'get')
    })

    afterEach(() => {
      axiosGetStub.restore()
    })

    it('returns invalid for unparseable identifier (no network call)', async () => {
      const outcome = await verifyNip05Identifier('not-an-identifier', pubkey)
      expect(outcome).to.deep.equal({ status: 'invalid', reason: 'unparseable NIP-05 identifier' })
      expect(axiosGetStub).not.to.have.been.called
    })

    it('sends request with capped redirects and body sizes', async () => {
      axiosGetStub.resolves({ data: { names: { alice: pubkey } } })

      await verifyNip05Identifier('alice@example.com', pubkey)

      const config = axiosGetStub.firstCall.args[1]
      expect(config.maxRedirects).to.equal(1)
      expect(config.maxContentLength)
        .to.be.a('number')
        .and.to.be.at.most(64 * 1024)
      expect(config.maxBodyLength)
        .to.be.a('number')
        .and.to.be.at.most(64 * 1024)
      expect(config.validateStatus(200)).to.be.true
      expect(config.validateStatus(301)).to.be.false
      expect(typeof config.beforeRedirect).to.equal('function')
    })

    it('returns verified when response pubkey matches', async () => {
      axiosGetStub.resolves({ data: { names: { alice: pubkey } } })

      const outcome = await verifyNip05Identifier('alice@example.com', pubkey)

      expect(outcome).to.deep.equal({ status: 'verified' })
    })

    it('returns mismatch when name is not present in response', async () => {
      axiosGetStub.resolves({ data: { names: { bob: pubkey } } })

      const outcome = await verifyNip05Identifier('alice@example.com', pubkey)

      expect(outcome).to.deep.equal({ status: 'mismatch' })
    })

    it('returns mismatch when pubkey does not match', async () => {
      axiosGetStub.resolves({ data: { names: { alice: 'b'.repeat(64) } } })

      const outcome = await verifyNip05Identifier('alice@example.com', pubkey)

      expect(outcome).to.deep.equal({ status: 'mismatch' })
    })

    it('returns invalid when response is not a JSON object', async () => {
      axiosGetStub.resolves({ data: 'not-json' })

      const outcome = await verifyNip05Identifier('alice@example.com', pubkey)

      expect(outcome.status).to.equal('invalid')
    })

    it('returns invalid when names is not an object', async () => {
      axiosGetStub.resolves({ data: { names: 'oops' } })

      const outcome = await verifyNip05Identifier('alice@example.com', pubkey)

      expect(outcome.status).to.equal('invalid')
    })

    it('returns invalid when a pubkey in names is not 64-char hex', async () => {
      axiosGetStub.resolves({ data: { names: { alice: 'not-hex' } } })

      const outcome = await verifyNip05Identifier('alice@example.com', pubkey)

      expect(outcome.status).to.equal('invalid')
    })

    it('returns error on network/timeout failure', async () => {
      axiosGetStub.rejects(new Error('ETIMEDOUT'))

      const outcome = await verifyNip05Identifier('alice@example.com', pubkey)

      expect(outcome.status).to.equal('error')
      if (outcome.status === 'error') {
        expect(outcome.reason).to.equal('ETIMEDOUT')
      }
    })

    describe('beforeRedirect SSRF guard', () => {
      let guard: (options: { href?: string; protocol?: string; hostname?: string }) => void

      beforeEach(async () => {
        axiosGetStub.resolves({ data: { names: { alice: pubkey } } })
        await verifyNip05Identifier('alice@example.com', pubkey)
        guard = axiosGetStub.firstCall.args[1].beforeRedirect
      })

      const allows = (href: string) => {
        expect(() => guard({ href })).not.to.throw()
      }
      const rejects = (href: string) => {
        expect(() => guard({ href })).to.throw(/refused redirect/)
      }

      it('allows https redirects to public hostnames', () => {
        allows('https://other.example.com/.well-known/nostr.json?name=alice')
      })

      it('rejects http redirects', () => {
        rejects('http://example.com/.well-known/nostr.json')
      })

      it('rejects redirects to loopback literal', () => {
        rejects('https://127.0.0.1/')
        rejects('https://127.99.99.99/')
      })

      it('rejects redirects to RFC1918 private ranges', () => {
        rejects('https://10.0.0.1/')
        rejects('https://192.168.1.1/')
        rejects('https://172.16.0.1/')
        rejects('https://172.31.255.254/')
      })

      it('rejects redirects to link-local addresses', () => {
        rejects('https://169.254.169.254/latest/meta-data/')
      })

      it('rejects redirects to localhost hostname', () => {
        rejects('https://localhost/')
        rejects('https://foo.localhost/')
      })

      it('rejects redirects to IPv6 literals', () => {
        rejects('https://[::1]/')
      })
    })
  })
})
