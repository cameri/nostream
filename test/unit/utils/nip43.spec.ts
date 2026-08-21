import chai from 'chai'
import sinon from 'sinon'
import sinonChai from 'sinon-chai'

import * as eventUtils from '../../../src/utils/event'
import {
  getRelayNip43Pubkey,
  isNip43InviteRequestFilter,
  isRelaySelfConsistent,
  resolveRelaySelfPubkey,
  tryGetRelayNip43Pubkey,
} from '../../../src/utils/nip43'
import { Settings } from '../../../src/@types/settings'
import { toBech32 } from '../../../src/utils/transform'

chai.use(sinonChai)
const { expect } = chai

describe('nip43 relay self pubkey', () => {
  const derivedPubkey = '22e804d26ed16b68db5259e78449e96dab5d464c8f470bda3eb1a70467f2c793'
  const otherPubkey = '1e0d0c0b0a09080706050403020100ff0e0d0c0b0a09080706050403020100ff'

  let sandbox: sinon.SinonSandbox
  let getRelayPrivateKeyStub: sinon.SinonStub
  let getPublicKeyStub: sinon.SinonStub

  const settingsWith = (self?: string): Settings =>
    ({ info: { relay_url: 'wss://relay.example.com', ...(self !== undefined ? { self } : {}) } }) as Settings

  beforeEach(() => {
    sandbox = sinon.createSandbox()
    // getRelayPrivateKey memoises in a module-level cache that ignores its
    // argument, so stub it rather than relying on a fresh derive per call.
    getRelayPrivateKeyStub = sandbox.stub(eventUtils, 'getRelayPrivateKey').returns('deadbeef')
    getPublicKeyStub = sandbox.stub(eventUtils, 'getPublicKey').returns(derivedPubkey)
  })

  afterEach(() => {
    sandbox.restore()
  })

  describe('getRelayNip43Pubkey', () => {
    it('derives the pubkey from the relay_url purpose', () => {
      expect(getRelayNip43Pubkey(settingsWith())).to.equal(derivedPubkey)
      expect(getRelayPrivateKeyStub).to.have.been.calledOnceWithExactly('wss://relay.example.com')
      expect(getPublicKeyStub).to.have.been.calledOnceWithExactly('deadbeef')
    })

    it('returns 64 lowercase hex characters', () => {
      getPublicKeyStub.callsFake((privkey: string) => getPublicKeyStub.wrappedMethod(privkey))
      getRelayPrivateKeyStub.returns(`${'0'.repeat(63)}1`)

      expect(getRelayNip43Pubkey(settingsWith())).to.match(/^[0-9a-f]{64}$/)
    })

    it('throws when SECRET is unset', () => {
      getRelayPrivateKeyStub.throws(new Error('SECRET environment variable not set'))

      expect(() => getRelayNip43Pubkey(settingsWith())).to.throw('SECRET environment variable not set')
    })
  })

  describe('tryGetRelayNip43Pubkey', () => {
    it('returns undefined instead of throwing when SECRET is unset', () => {
      getRelayPrivateKeyStub.throws(new Error('SECRET environment variable not set'))

      expect(tryGetRelayNip43Pubkey(settingsWith())).to.be.undefined
    })
  })

  describe('isRelaySelfConsistent', () => {
    it('returns undefined when info.self is unset', () => {
      expect(isRelaySelfConsistent(settingsWith())).to.be.undefined
    })

    it('returns undefined when info.self is the placeholder default', () => {
      expect(isRelaySelfConsistent(settingsWith('replace-with-your-relay-pubkey-in-hex'))).to.be.undefined
    })

    it('returns undefined when the signing pubkey cannot be derived', () => {
      getRelayPrivateKeyStub.throws(new Error('SECRET environment variable not set'))

      expect(isRelaySelfConsistent(settingsWith(derivedPubkey))).to.be.undefined
    })

    it('returns true when info.self matches in hex', () => {
      expect(isRelaySelfConsistent(settingsWith(derivedPubkey.toUpperCase()))).to.equal(true)
    })

    it('returns true when info.self matches as an npub', () => {
      expect(isRelaySelfConsistent(settingsWith(toBech32('npub')(derivedPubkey)))).to.equal(true)
    })

    it('returns false when info.self does not match', () => {
      expect(isRelaySelfConsistent(settingsWith(otherPubkey))).to.equal(false)
    })

    it('throws when info.self is a malformed npub', () => {
      expect(() => isRelaySelfConsistent(settingsWith('npub1notavalidbech32string'))).to.throw()
    })
  })

  describe('resolveRelaySelfPubkey', () => {
    it('falls back to the derived pubkey when info.self is unset', () => {
      expect(resolveRelaySelfPubkey(settingsWith())).to.equal(derivedPubkey)
    })

    it('falls back to the derived pubkey when info.self is the placeholder default', () => {
      expect(resolveRelaySelfPubkey(settingsWith('replace-with-your-relay-pubkey-in-hex'))).to.equal(derivedPubkey)
    })

    it('prefers a configured hex info.self, normalised to lowercase', () => {
      expect(resolveRelaySelfPubkey(settingsWith(otherPubkey.toUpperCase()))).to.equal(otherPubkey)
    })

    it('decodes a configured npub info.self', () => {
      expect(resolveRelaySelfPubkey(settingsWith(toBech32('npub')(otherPubkey)))).to.equal(otherPubkey)
    })

    it('falls back to the derived pubkey instead of throwing on a malformed npub', () => {
      expect(resolveRelaySelfPubkey(settingsWith('npub1notavalidbech32string'))).to.equal(derivedPubkey)
    })

    it('returns undefined when nothing is configured and SECRET is unset', () => {
      getRelayPrivateKeyStub.throws(new Error('SECRET environment variable not set'))

      expect(resolveRelaySelfPubkey(settingsWith())).to.be.undefined
    })
  })

  describe('isNip43InviteRequestFilter', () => {
    it('matches a filter naming kind 28935', () => {
      expect(isNip43InviteRequestFilter({ kinds: [28935] })).to.equal(true)
    })

    it('matches a filter naming 28935 alongside other kinds', () => {
      expect(isNip43InviteRequestFilter({ kinds: [1, 28935] })).to.equal(true)
    })

    it('does not match a filter naming other kinds', () => {
      expect(isNip43InviteRequestFilter({ kinds: [28934, 28936] })).to.equal(false)
    })

    it('does not match a filter with no kinds', () => {
      expect(isNip43InviteRequestFilter({ authors: ['a'.repeat(64)] })).to.equal(false)
    })

    it('does not match an empty filter', () => {
      expect(isNip43InviteRequestFilter({})).to.equal(false)
    })
  })
})
