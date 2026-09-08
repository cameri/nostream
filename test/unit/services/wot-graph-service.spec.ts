import chai from 'chai'
import chaiAsPromised from 'chai-as-promised'
import Sinon from 'sinon'
import sinonChai from 'sinon-chai'

chai.use(sinonChai)
chai.use(chaiAsPromised)

const { expect } = chai

import { DBEvent } from '../../../src/@types/event'
import { ICacheAdapter } from '../../../src/@types/adapters'
import { IEventRepository } from '../../../src/@types/repositories'
import { Settings } from '../../../src/@types/settings'
import { Tag } from '../../../src/@types/base'
import { WotGraphService } from '../../../src/services/wot-graph-service'

describe('WotGraphService', () => {
  const seedPubkey = 'a'.repeat(64)

  let cache: ICacheAdapter
  let eventRepository: IEventRepository
  let settings: Settings

  let getSetMembersStub: Sinon.SinonStub
  let addToSetStub: Sinon.SinonStub
  let deleteKeyStub: Sinon.SinonStub
  let findByFiltersStub: Sinon.SinonStub

  let sandbox: Sinon.SinonSandbox

  let originalConsoleError: typeof console.error

  const dbEventWithFollows = (tags: Tag[]): DBEvent =>
    ({
      id: 'row-id',
      event_id: Buffer.from('00', 'hex'),
      event_pubkey: Buffer.from('00', 'hex'),
      event_kind: 3,
      event_created_at: 0,
      event_content: '',
      event_tags: tags,
      event_signature: Buffer.from('00', 'hex'),
      first_seen: new Date(),
    }) as any

  const followsOf: Record<string, string[]> = {}

  const service = () => new WotGraphService(cache, eventRepository, () => settings)

  beforeEach(() => {
    sandbox = Sinon.createSandbox()
    originalConsoleError = console.error
    console.error = () => undefined

    for (const key of Object.keys(followsOf)) {
      delete followsOf[key]
    }

    getSetMembersStub = sandbox.stub().callsFake(async (key: string) => {
      const pubkey = key.replace('wot:follows:', '')
      return followsOf[pubkey] ?? []
    })
    addToSetStub = sandbox.stub().callsFake(async (key: string, members: string[]) => {
      const pubkey = key.replace('wot:follows:', '')
      followsOf[pubkey] = [...(followsOf[pubkey] ?? []), ...members]
      return members.length
    })
    deleteKeyStub = sandbox.stub().callsFake(async (key: string) => {
      const pubkey = key.replace('wot:follows:', '')
      delete followsOf[pubkey]
      return 1
    })
    cache = {
      getSetMembers: getSetMembersStub,
      addToSet: addToSetStub,
      deleteKey: deleteKeyStub,
    } as any

    findByFiltersStub = sandbox.stub().resolves([])
    eventRepository = {
      findByFilters: findByFiltersStub,
    } as any

    settings = {
      wot: {
        enabled: true,
        seedPubkey,
        minimumFollowers: 1,
        maxDepth: 2,
        refreshIntervalHours: 24,
      },
    } as any
  })

  afterEach(() => {
    console.error = originalConsoleError
    sandbox.restore()
  })

  describe('isReady', () => {
    it('is false before any distance has been resolved', () => {
      expect(service().isReady()).to.equal(false)
    })

    it('is true after a distance lookup triggers a build', async () => {
      const wot = service()
      await wot.getDistance('someone')
      expect(wot.isReady()).to.equal(true)
    })
  })

  describe('getDistance', () => {
    it('returns undefined when wot is disabled', async () => {
      settings.wot!.enabled = false
      const distance = await service().getDistance('someone')
      expect(distance).to.be.undefined
      expect(getSetMembersStub).not.to.have.been.called
    })

    it('returns 0 for the seed pubkey without building the graph', async () => {
      const distance = await service().getDistance(seedPubkey)
      expect(distance).to.equal(0)
      expect(getSetMembersStub).not.to.have.been.called
    })

    it('returns 1 for a direct follow of the seed', async () => {
      followsOf[seedPubkey] = ['direct-follow']
      const distance = await service().getDistance('direct-follow')
      expect(distance).to.equal(1)
    })

    it('returns undefined for a pubkey outside the trust graph', async () => {
      followsOf[seedPubkey] = ['direct-follow']
      const distance = await service().getDistance('stranger')
      expect(distance).to.be.undefined
    })

    it('includes a 2-hop pubkey once it meets minimumFollowers', async () => {
      settings.wot!.minimumFollowers = 2
      followsOf[seedPubkey] = ['a', 'b']
      followsOf.a = ['c']
      followsOf.b = ['c']

      const distance = await service().getDistance('c')
      expect(distance).to.equal(2)
    })

    it('excludes a 2-hop pubkey that does not meet minimumFollowers', async () => {
      settings.wot!.minimumFollowers = 2
      followsOf[seedPubkey] = ['a', 'b']
      followsOf.a = ['d']
      // only followed by 'a', not 'b' -- below the threshold of 2

      const distance = await service().getDistance('d')
      expect(distance).to.be.undefined
    })

    it('does not look beyond the configured maxDepth', async () => {
      settings.wot!.maxDepth = 1
      followsOf[seedPubkey] = ['a']
      followsOf.a = ['c']

      const distance = await service().getDistance('c')
      expect(distance).to.be.undefined
    })

    it('falls back to the event repository when a follow list is not cached, and primes the cache', async () => {
      settings.wot!.maxDepth = 1
      findByFiltersStub.resolves([dbEventWithFollows([['p', 'direct-follow']])])

      const distance = await service().getDistance('direct-follow')

      expect(distance).to.equal(1)
      expect(findByFiltersStub).to.have.been.calledOnceWithExactly([{ kinds: [3], authors: [seedPubkey], limit: 1 }])
      expect(addToSetStub).to.have.been.calledOnceWithExactly(`wot:follows:${seedPubkey}`, ['direct-follow'])
    })

    it('promotes a candidate once its cumulative followers across depths meet minimumFollowers, even if no single depth layer alone does', async () => {
      settings.wot!.minimumFollowers = 2
      settings.wot!.maxDepth = 3
      followsOf[seedPubkey] = ['a', 'p', 'q']
      followsOf.a = ['x'] // x gets 1 follower from the depth-1 layer -- not enough alone
      followsOf.p = ['b']
      followsOf.q = ['b'] // b gets 2 depth-1 followers -- promoted to depth 2
      followsOf.b = ['x'] // x gets a 2nd follower from the depth-2 layer -- 1 + 1 = 2 total

      expect(await service().getDistance('x')).to.equal(3)
    })

    it('treats an invalid seedPubkey as an empty graph instead of throwing', async () => {
      settings.wot!.seedPubkey = 'not-a-valid-hex-pubkey'

      const distance = await service().getDistance('anyone')

      expect(distance).to.be.undefined
    })
  })

  describe('isTrusted', () => {
    it('is true for a pubkey within the trust graph', async () => {
      followsOf[seedPubkey] = ['direct-follow']
      expect(await service().isTrusted('direct-follow')).to.equal(true)
    })

    it('is false for a pubkey outside the trust graph', async () => {
      expect(await service().isTrusted('stranger')).to.equal(false)
    })
  })

  describe('updateFollowList', () => {
    it('does nothing when wot is disabled', async () => {
      settings.wot!.enabled = false
      await service().updateFollowList(seedPubkey, ['a'])
      expect(deleteKeyStub).not.to.have.been.called
    })

    it('clears and repopulates the pubkey follow set', async () => {
      await service().updateFollowList(seedPubkey, ['a', 'b'])
      expect(deleteKeyStub).to.have.been.calledOnceWithExactly(`wot:follows:${seedPubkey}`)
      expect(addToSetStub).to.have.been.calledOnceWithExactly(`wot:follows:${seedPubkey}`, ['a', 'b'])
    })

    it('does not call addToSet for an empty follow list', async () => {
      await service().updateFollowList(seedPubkey, [])
      expect(deleteKeyStub).to.have.been.calledOnce
      expect(addToSetStub).not.to.have.been.called
    })

    it('rebuilds the graph when the seed pubkey changes', async () => {
      const wot = service()
      await wot.getDistance('anyone') // triggers the first build, marks ready
      getSetMembersStub.resetHistory()

      await wot.updateFollowList(seedPubkey, ['a'])
      await (wot as any).building // the triggered rebuild is fire-and-forget; wait for it here

      expect(getSetMembersStub).to.have.been.called // rebuild re-read the graph
      expect(await wot.getDistance('a')).to.equal(1)
    })

    it('does not rebuild when an untracked pubkey changes', async () => {
      const wot = service()
      await wot.getDistance('anyone') // triggers the first build, marks ready
      getSetMembersStub.resetHistory()

      await wot.updateFollowList('unrelated-pubkey', ['x'])

      expect(getSetMembersStub).not.to.have.been.called
    })

    it('does not block on the triggered rebuild (fire-and-forget)', async () => {
      const wot = service()
      await wot.getDistance('anyone') // first build completes, ready=true

      let releaseRebuild: () => void = () => undefined
      getSetMembersStub.callsFake(async (key: string) => {
        const pubkey = key.replace('wot:follows:', '')
        if (pubkey === seedPubkey) {
          await new Promise<void>((resolve) => {
            releaseRebuild = resolve
          })
        }
        return followsOf[pubkey] ?? []
      })

      let updateFollowListResolved = false
      const updatePromise = wot.updateFollowList(seedPubkey, ['a']).then(() => {
        updateFollowListResolved = true
      })

      await updatePromise // only awaits the Redis writes, not the stuck rebuild
      expect(updateFollowListResolved).to.equal(true)

      releaseRebuild()
      await (wot as any).building
    })

    it('recovers after a rebuild failure instead of staying stuck on a rejected promise', async () => {
      findByFiltersStub.rejects(new Error('db unavailable'))

      const wot = service()
      await wot.getDistance('anyone') // build fails internally; caught, not thrown
      expect(wot.isReady()).to.equal(false)

      findByFiltersStub.resolves([]) // "recovery"
      await wot.getDistance('anyone') // must retry, not hang on the earlier failure
      expect(wot.isReady()).to.equal(true)
    })
  })
})
