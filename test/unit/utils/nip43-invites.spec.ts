import * as chai from 'chai'
import chaiAsPromised from 'chai-as-promised'
import * as sinon from 'sinon'
import sinonChai from 'sinon-chai'
import { InviteCode } from '../../../src/@types/invite-code'
import { IInviteCodeRepository } from '../../../src/@types/repositories'
import { Nip43Settings } from '../../../src/@types/settings'
import {
  buildInviteCodeEvent,
  DEFAULT_INVITE_CODE_EXPIRY_SECONDS,
  DEFAULT_INVITE_MAX_USES,
  generateInviteCode,
  isHexPubkey,
  issueInviteCode,
  parseRelayPubkey,
  resolveInviteCodeLimits,
} from '../../../src/utils/nip43-invites'
import { EventTags } from '../../../src/constants/base'
import { getPublicKey, isEventIdValid, isEventSignatureValid } from '../../../src/utils/event'
import { toBech32 } from '../../../src/utils/transform'

chai.use(sinonChai)
chai.use(chaiAsPromised)

const { expect } = chai

describe('nip43-invites', () => {
  const pubkey = '22e804d26ed16b68db5259e78449e96dab5d464c8f470bda3eb1a70467f2c793'
  const fixedNow = new Date('2026-08-15T12:00:00.000Z')

  let sandbox: sinon.SinonSandbox

  beforeEach(() => {
    sandbox = sinon.createSandbox()
    sandbox.useFakeTimers(fixedNow.getTime())
  })

  afterEach(() => {
    sandbox.restore()
  })

  describe('generateInviteCode', () => {
    it('returns a 32-character hex string', () => {
      const code = generateInviteCode()
      expect(code).to.be.a('string')
      expect(code).to.have.lengthOf(32)
      expect(code).to.match(/^[0-9a-f]{32}$/)
    })

    it('generates unique codes on successive calls', () => {
      const codes = new Set(Array.from({ length: 50 }, () => generateInviteCode()))
      expect(codes.size).to.equal(50)
    })
  })

  describe('isHexPubkey', () => {
    it('accepts 64-character hex', () => {
      expect(isHexPubkey(pubkey)).to.equal(true)
      expect(isHexPubkey(pubkey.toUpperCase())).to.equal(true)
    })

    it('rejects placeholders and short values', () => {
      expect(isHexPubkey('replace-with-your-relay-pubkey-in-hex')).to.equal(false)
      expect(isHexPubkey('aabbcc')).to.equal(false)
      expect(isHexPubkey(undefined)).to.equal(false)
      expect(isHexPubkey(null)).to.equal(false)
    })
  })

  describe('parseRelayPubkey', () => {
    it('lowercases hex pubkeys', () => {
      expect(parseRelayPubkey(pubkey.toUpperCase())).to.equal(pubkey)
    })

    it('decodes npub1 self the same way NIP-11 does', () => {
      expect(parseRelayPubkey(toBech32('npub')(pubkey))).to.equal(pubkey)
    })

    it('omits the settings placeholder and other non-pubkeys', () => {
      expect(parseRelayPubkey('replace-with-your-relay-pubkey-in-hex')).to.equal(undefined)
      expect(parseRelayPubkey('')).to.equal(undefined)
      expect(parseRelayPubkey(undefined)).to.equal(undefined)
    })

    it('throws on a malformed npub', () => {
      expect(() => parseRelayPubkey('npub1invalid')).to.throw()
    })
  })

  describe('resolveInviteCodeLimits', () => {
    it('defaults to one use and a 10-minute expiry', () => {
      expect(resolveInviteCodeLimits(undefined)).to.deep.equal({
        remainingUses: DEFAULT_INVITE_MAX_USES,
        expiresAt: new Date(fixedNow.getTime() + DEFAULT_INVITE_CODE_EXPIRY_SECONDS * 1000),
      })
    })

    it('reads defaultMaxUses and inviteCodeExpirySeconds from settings', () => {
      const settings: Nip43Settings = { enabled: true, defaultMaxUses: 3, inviteCodeExpirySeconds: 60 }

      expect(resolveInviteCodeLimits(settings)).to.deep.equal({
        remainingUses: 3,
        expiresAt: new Date(fixedNow.getTime() + 60_000),
      })
    })

    it('treats inviteCodeExpirySeconds 0 as never expires', () => {
      expect(resolveInviteCodeLimits({ enabled: false, inviteCodeExpirySeconds: 0, defaultMaxUses: 1 })).to.deep.equal({
        remainingUses: 1,
        expiresAt: null,
      })
    })

    it('lets overrides win over settings', () => {
      const expiresAt = new Date('2026-08-16T00:00:00.000Z')
      const settings: Nip43Settings = { enabled: true, defaultMaxUses: 9, inviteCodeExpirySeconds: 3600 }

      expect(resolveInviteCodeLimits(settings, { remainingUses: 2, expiresAt })).to.deep.equal({
        remainingUses: 2,
        expiresAt,
      })
    })

    it('rejects non-positive remainingUses', () => {
      expect(() => resolveInviteCodeLimits(undefined, { remainingUses: 0 })).to.throw('positive integer')
      expect(() => resolveInviteCodeLimits({ enabled: false, defaultMaxUses: -1 })).to.throw('positive integer')
    })
  })

  describe('issueInviteCode', () => {
    const stored: InviteCode = {
      code: 'abc123deadbeef4567890000cafebabe',
      createdBy: null,
      claimedBy: null,
      expiresAt: null,
      remainingUses: 1,
      createdAt: fixedNow,
      updatedAt: fixedNow,
    }

    it('uses a 10-minute expiry when settings omit inviteCodeExpirySeconds', async () => {
      const create = sandbox.stub().resolves(stored)
      const repository = { create } as unknown as IInviteCodeRepository

      await issueInviteCode(repository, { enabled: false })

      expect(create.firstCall.args[1].expiresAt).to.deep.equal(
        new Date(fixedNow.getTime() + DEFAULT_INVITE_CODE_EXPIRY_SECONDS * 1000),
      )
    })

    it('generates a code and persists yaml defaults', async () => {
      const create = sandbox.stub().resolves(stored)
      const repository = { create } as unknown as IInviteCodeRepository

      const result = await issueInviteCode(repository, { enabled: false, defaultMaxUses: 1, inviteCodeExpirySeconds: 0 })

      expect(result).to.equal(stored)
      expect(create).to.have.been.calledOnce
      const [code, options] = create.firstCall.args
      expect(code).to.match(/^[0-9a-f]{32}$/)
      expect(options).to.deep.equal({
        remainingUses: 1,
        expiresAt: null,
        createdBy: null,
      })
    })

    it('lowercases a valid createdBy pubkey', async () => {
      const create = sandbox.stub().resolves(stored)
      const repository = { create } as unknown as IInviteCodeRepository

      await issueInviteCode(repository, undefined, { createdBy: pubkey.toUpperCase() })

      expect(create.firstCall.args[1].createdBy).to.equal(pubkey)
    })

    it('rejects an invalid createdBy pubkey', async () => {
      const repository = { create: sandbox.stub() } as unknown as IInviteCodeRepository

      await expect(issueInviteCode(repository, undefined, { createdBy: 'not-a-pubkey' })).to.be.rejectedWith(
        'createdBy must be a 64-character hex pubkey',
      )
      expect((repository.create as sinon.SinonStub).called).to.equal(false)
    })
  })

  describe('buildInviteCodeEvent', () => {
    const relayPrivkey = '5c0c523f52a5b6fad39ed2403092df8cebc36318b39383bca6c00808626fab3a'
    const relayPubkey = getPublicKey(relayPrivkey)
    const code = 'ffee0011223344556677889900aabbcc'

    it('builds a kind 28935 event signed by the relay', async () => {
      const event = await buildInviteCodeEvent(relayPrivkey, relayPubkey, { code, expiresAt: null }, 1700000000)

      expect(event.kind).to.equal(28935)
      expect(event.pubkey).to.equal(relayPubkey)
      expect(event.created_at).to.equal(1700000000)
      expect(event.content).to.equal('')
    })

    it('produces a valid event id and signature', async () => {
      const event = await buildInviteCodeEvent(relayPrivkey, relayPubkey, { code, expiresAt: null })

      expect(await isEventIdValid(event)).to.equal(true)
      expect(await isEventSignatureValid(event)).to.equal(true)
    })

    it('carries the claim code in a claim tag', async () => {
      const event = await buildInviteCodeEvent(relayPrivkey, relayPubkey, { code, expiresAt: null })

      expect(event.tags).to.deep.include([EventTags.Claim, code])
    })

    it('marks the event NIP-70 protected', async () => {
      const event = await buildInviteCodeEvent(relayPrivkey, relayPubkey, { code, expiresAt: null })

      expect(event.tags).to.deep.include([EventTags.Protected])
    })

    it('adds a NIP-40 expiration tag in seconds when the code expires', async () => {
      const expiresAt = new Date('2026-08-20T12:00:00.000Z')

      const event = await buildInviteCodeEvent(relayPrivkey, relayPubkey, { code, expiresAt })

      expect(event.tags).to.deep.include([EventTags.Expiration, String(expiresAt.getTime() / 1000)])
    })

    it('omits the expiration tag when the code never expires', async () => {
      const event = await buildInviteCodeEvent(relayPrivkey, relayPubkey, { code, expiresAt: null })

      expect(event.tags.some((tag) => tag[0] === EventTags.Expiration)).to.equal(false)
    })

    it('defaults created_at to now', async () => {
      const before = Math.floor(Date.now() / 1000)

      const event = await buildInviteCodeEvent(relayPrivkey, relayPubkey, { code, expiresAt: null })

      expect(event.created_at).to.be.at.least(before)
      expect(event.created_at).to.be.at.most(Math.floor(Date.now() / 1000))
    })
  })
})
