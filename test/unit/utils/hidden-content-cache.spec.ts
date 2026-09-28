import chai, { expect } from 'chai'
import chaiAsPromised from 'chai-as-promised'
import Sinon from 'sinon'
import sinonChai from 'sinon-chai'

chai.use(sinonChai)
chai.use(chaiAsPromised)

import { ICacheAdapter } from '../../../src/@types/adapters'
import { IReportRepository } from '../../../src/@types/repositories'
import {
  isHidden,
  markActionableTarget,
  resetHiddenContentCache,
  startHiddenContentCache,
  stopHiddenContentCache,
} from '../../../src/utils/hidden-content-cache'

describe('hidden-content-cache', () => {
  let cache: ICacheAdapter
  let addToSetStub: Sinon.SinonStub
  let getSetMembersStub: Sinon.SinonStub

  beforeEach(() => {
    addToSetStub = Sinon.stub().resolves(1)
    getSetMembersStub = Sinon.stub().resolves([])
    cache = { addToSet: addToSetStub, getSetMembers: getSetMembersStub } as unknown as ICacheAdapter
  })

  afterEach(() => {
    resetHiddenContentCache()
    stopHiddenContentCache()
  })

  describe('markActionableTarget/isHidden', () => {
    it('marks the pubkey in memory and in the cache', async () => {
      await markActionableTarget(cache, { reportedPubkey: 'a'.repeat(64), reportedEventId: null })

      expect(isHidden({ id: 'b'.repeat(64), pubkey: 'a'.repeat(64) })).to.be.true
      expect(addToSetStub).to.have.been.calledOnceWithExactly('nip56:hidden:pubkeys', ['a'.repeat(64)])
    })

    it('marks the event id in memory and in the cache', async () => {
      await markActionableTarget(cache, { reportedPubkey: null, reportedEventId: 'c'.repeat(64) })

      expect(isHidden({ id: 'c'.repeat(64), pubkey: 'd'.repeat(64) })).to.be.true
      expect(addToSetStub).to.have.been.calledOnceWithExactly('nip56:hidden:event_ids', ['c'.repeat(64)])
    })

    it('does not hide an unmarked event', async () => {
      await markActionableTarget(cache, { reportedPubkey: 'a'.repeat(64), reportedEventId: null })

      expect(isHidden({ id: 'e'.repeat(64), pubkey: 'f'.repeat(64) })).to.be.false
    })

    it('does not touch the cache for a target with both fields null', async () => {
      await markActionableTarget(cache, { reportedPubkey: null, reportedEventId: null })

      expect(addToSetStub).not.to.have.been.called
    })
  })

  describe('startHiddenContentCache', () => {
    it('seeds Redis from every actionable target in the DB, then loads the merged Redis state', async () => {
      const reportRepository = {
        findActionableTargets: Sinon.stub().resolves([{ reportedPubkey: 'a'.repeat(64), reportedEventId: null }]),
      } as unknown as IReportRepository
      getSetMembersStub.withArgs('nip56:hidden:pubkeys').resolves(['a'.repeat(64), 'z'.repeat(64)])
      getSetMembersStub.withArgs('nip56:hidden:event_ids').resolves([])

      await startHiddenContentCache(cache, reportRepository)

      expect(addToSetStub).to.have.been.calledOnceWithExactly('nip56:hidden:pubkeys', ['a'.repeat(64)])
      // z...z came from Redis only (e.g. written by another worker), not from this worker's own DB read.
      expect(isHidden({ id: 'x'.repeat(64), pubkey: 'z'.repeat(64) })).to.be.true
      expect(isHidden({ id: 'x'.repeat(64), pubkey: 'a'.repeat(64) })).to.be.true
    })

    it('logs and continues if the DB seed query fails, without throwing', async () => {
      const reportRepository = {
        findActionableTargets: Sinon.stub().rejects(new Error('db down')),
      } as unknown as IReportRepository

      await expect(startHiddenContentCache(cache, reportRepository)).to.eventually.be.fulfilled
    })

    it('periodically refreshes the in-memory cache from Redis', async () => {
      const clock = Sinon.useFakeTimers()
      try {
        const reportRepository = {
          findActionableTargets: Sinon.stub().resolves([]),
        } as unknown as IReportRepository

        await startHiddenContentCache(cache, reportRepository, 1000)
        getSetMembersStub.withArgs('nip56:hidden:pubkeys').resolves(['later'.padEnd(64, '0')])

        await clock.tickAsync(1000)

        expect(isHidden({ id: 'x'.repeat(64), pubkey: 'later'.padEnd(64, '0') })).to.be.true
      } finally {
        clock.restore()
      }
    })
  })

  describe('resetHiddenContentCache', () => {
    it('clears previously marked targets', async () => {
      await markActionableTarget(cache, { reportedPubkey: 'a'.repeat(64), reportedEventId: null })
      resetHiddenContentCache()

      expect(isHidden({ id: 'z'.repeat(64), pubkey: 'a'.repeat(64) })).to.be.false
    })
  })
})
