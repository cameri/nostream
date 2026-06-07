import chai from 'chai'
import chaiAsPromised from 'chai-as-promised'
import Sinon from 'sinon'
import sinonChai from 'sinon-chai'

import { WoTSettings } from '../../../src/@types/settings'
import { WotService, RelayFetcher } from '../../../src/services/wot-service'

chai.use(sinonChai)
chai.use(chaiAsPromised)

const { expect } = chai

const SEED_PUBKEY   = 'a'.repeat(64)
const TRUSTED_PUBKEY   = 'b'.repeat(64)
const UNTRUSTED_PUBKEY = 'c'.repeat(64)
const UNKNOWN_PUBKEY   = 'd'.repeat(64)

const baseSettings: WoTSettings = {
  enabled: true,
  seedPubkey: SEED_PUBKEY,
  minimumFollowers: 1,
  refreshIntervalHours: 24,
  seedRelays: ['wss://relay.example.com'],
}

/** Building a minimal kind-3 event */
function makeFollowEvent(id: string, authorPubkey: string, follows: string[]): object {
  return {
    id,
    pubkey: authorPubkey,
    kind: 3,
    tags: follows.map((pk) => ['p', pk]),
    content: '',
    created_at: 1_700_000_000,
    sig: 'f'.repeat(128),
  }
}

describe('WotService', () => {
  let sandbox: Sinon.SinonSandbox
  let fetcher: Sinon.SinonStub
  let service: WotService

  beforeEach(() => {
    sandbox = Sinon.createSandbox()
    // Default: return empty list for every relay fetch call
    fetcher = sandbox.stub<Parameters<RelayFetcher>, ReturnType<RelayFetcher>>().resolves([])
    service = new WotService(fetcher)
  })

  afterEach(() => {
    sandbox.restore()
  })

  // testing initial state:

  describe('before any build', () => {
    it('isReady() returns false', () => {
      expect(service.isReady()).to.equal(false)
    })

    it('isTrusted() returns false for any pubkey', () => {
      expect(service.isTrusted(SEED_PUBKEY)).to.equal(false)
      expect(service.isTrusted(TRUSTED_PUBKEY)).to.equal(false)
    })
  })

  // testing the build graph state:

  describe('buildGraph()', () => {
    it('sets isReady() to true after a successful build', async () => {
      await service.buildGraph(baseSettings)

      expect(service.isReady()).to.equal(true)
    })

    it('seedPubkey is always trusted after build regardless of follower count', async () => {
      // fetcher returns nothing — seed has no followers at all
      fetcher.resolves([])

      await service.buildGraph(baseSettings)

      expect(service.isTrusted(SEED_PUBKEY)).to.equal(true)
    })

    it('trusts a pubkey that meets minimumFollowers threshold', async () => {
      // phase 1: seed follows TRUSTED_PUBKEY (follower count = 1)
      fetcher.onFirstCall().resolves([
        makeFollowEvent('evt1', SEED_PUBKEY, [TRUSTED_PUBKEY]),
      ])

      await service.buildGraph({ ...baseSettings, minimumFollowers: 1 })

      expect(service.isTrusted(TRUSTED_PUBKEY)).to.equal(true)
    })

    it('does not trust a pubkey below minimumFollowers threshold', async () => {
      // phase 1: seed follows TRUSTED_PUBKEY
      // phase 2: TRUSTED_PUBKEY follows UNTRUSTED_PUBKEY
      // UNTRUSTED_PUBKEY has count=1, minimumFollowers=2 → not trusted
      fetcher.onFirstCall().resolves([
        makeFollowEvent('evt1', SEED_PUBKEY, [TRUSTED_PUBKEY]),
      ])
      fetcher.onSecondCall().resolves([
        makeFollowEvent('evt2', TRUSTED_PUBKEY, [UNTRUSTED_PUBKEY]),
      ])

      await service.buildGraph({ ...baseSettings, minimumFollowers: 2 })

      expect(service.isTrusted(UNTRUSTED_PUBKEY)).to.equal(false)
    })

    it('returns false for a pubkey not seen in any follow list', async () => {
      fetcher.onFirstCall().resolves([
        makeFollowEvent('evt1', SEED_PUBKEY, [TRUSTED_PUBKEY]),
      ])

      await service.buildGraph(baseSettings)

      expect(service.isTrusted(UNKNOWN_PUBKEY)).to.equal(false)
    })

    it('is a no-op when a build is already in flight', async () => {
      // first call hangs — never resolves
      let releaseHang!: () => void
      fetcher.onFirstCall().returns(
        new Promise<any[]>((resolve) => { releaseHang = () => resolve([]) })
      )

      // start first build — hangs on phase 1 fetch
      const first = service.buildGraph(baseSettings)

      // second call while first is in flight — must return immediately
      await service.buildGraph(baseSettings)

      // fetcher called only once (by the first build)
      expect(fetcher.callCount).to.equal(1)

      // clean up
      releaseHang()
      await first
    })

    it('clears the building flag even when buildGraph throws', async () => {
      fetcher.onFirstCall().rejects(new Error('relay unreachable'))

      await expect(service.buildGraph(baseSettings)).to.eventually.be.rejectedWith('relay unreachable')

      // building flag must be cleared — a subsequent build must proceed
      fetcher.reset()
      fetcher.resolves([])

      await expect(service.buildGraph(baseSettings)).to.eventually.be.fulfilled
    })

    it('phase 1 tag parsing ignores non-p tags', async () => {
      fetcher.onFirstCall().resolves([
        {
          id: 'evt1',
          pubkey: SEED_PUBKEY,
          kind: 3,
          tags: [
            ['e', TRUSTED_PUBKEY],   // wrong tag type — must be ignored
            ['p', TRUSTED_PUBKEY],   // correct
          ],
          content: '',
          created_at: 1_700_000_000,
          sig: 'f'.repeat(128),
        },
      ])

      await service.buildGraph(baseSettings)

      expect(service.isTrusted(TRUSTED_PUBKEY)).to.equal(true)
    })

    it('phase 1 tag parsing ignores pubkeys that are not 64 hex chars', async () => {
      fetcher.onFirstCall().resolves([
        {
          id: 'evt1',
          pubkey: SEED_PUBKEY,
          kind: 3,
          tags: [
            ['p', 'tooshort'],          // invalid length — must be ignored
            ['p', TRUSTED_PUBKEY],      // valid
          ],
          content: '',
          created_at: 1_700_000_000,
          sig: 'f'.repeat(128),
        },
      ])

      await service.buildGraph(baseSettings)

      expect(service.isTrusted('tooshort')).to.equal(false)
      expect(service.isTrusted(TRUSTED_PUBKEY)).to.equal(true)
    })
  })

  // testting reset functionality:

  describe('reset()', () => {
    it('clears booted state — isReady() returns false after reset', async () => {
      await service.buildGraph(baseSettings)
      expect(service.isReady()).to.equal(true)

      service.reset()

      expect(service.isReady()).to.equal(false)
    })

    it('clears trust map — isTrusted() returns false for all pubkeys after reset', async () => {
      fetcher.onFirstCall().resolves([
        makeFollowEvent('evt1', SEED_PUBKEY, [TRUSTED_PUBKEY]),
      ])
      await service.buildGraph(baseSettings)
      expect(service.isTrusted(SEED_PUBKEY)).to.equal(true)
      expect(service.isTrusted(TRUSTED_PUBKEY)).to.equal(true)

      service.reset()

      expect(service.isTrusted(SEED_PUBKEY)).to.equal(false)
      expect(service.isTrusted(TRUSTED_PUBKEY)).to.equal(false)
    })

    it('allows a fresh build after reset', async () => {
      await service.buildGraph(baseSettings)
      service.reset()

      fetcher.reset()
      fetcher.resolves([])

      await service.buildGraph(baseSettings)

      expect(service.isReady()).to.equal(true)
    })
  })
})
