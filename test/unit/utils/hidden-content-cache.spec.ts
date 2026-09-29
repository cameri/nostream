import chai, { expect } from 'chai'
import chaiAsPromised from 'chai-as-promised'
import Sinon from 'sinon'
import sinonChai from 'sinon-chai'

chai.use(sinonChai)
chai.use(chaiAsPromised)

import { IReportRepository } from '../../../src/@types/repositories'
import {
  isHidden,
  markActionableTarget,
  resetHiddenContentCache,
  startHiddenContentCache,
  stopHiddenContentCache,
} from '../../../src/utils/hidden-content-cache'

describe('hidden-content-cache', () => {
  afterEach(() => {
    resetHiddenContentCache()
    stopHiddenContentCache()
  })

  describe('markActionableTarget/isHidden', () => {
    it('hides an event whose pubkey was marked', () => {
      markActionableTarget({ reportedPubkey: 'a'.repeat(64), reportedEventId: null })

      expect(isHidden({ id: 'b'.repeat(64), pubkey: 'a'.repeat(64) })).to.be.true
    })

    it('hides an event whose id was marked', () => {
      markActionableTarget({ reportedPubkey: null, reportedEventId: 'c'.repeat(64) })

      expect(isHidden({ id: 'c'.repeat(64), pubkey: 'd'.repeat(64) })).to.be.true
    })

    it('does not hide an unmarked event', () => {
      markActionableTarget({ reportedPubkey: 'a'.repeat(64), reportedEventId: null })

      expect(isHidden({ id: 'e'.repeat(64), pubkey: 'f'.repeat(64) })).to.be.false
    })

    it('ignores a target with both fields null', () => {
      markActionableTarget({ reportedPubkey: null, reportedEventId: null })

      expect(isHidden({ id: 'g'.repeat(64), pubkey: 'h'.repeat(64) })).to.be.false
    })
  })

  describe('startHiddenContentCache', () => {
    it('seeds the cache from the DB at boot', async () => {
      const reportRepository = {
        findActionableTargets: Sinon.stub().resolves([{ reportedPubkey: 'a'.repeat(64), reportedEventId: null }]),
      } as unknown as IReportRepository

      await startHiddenContentCache(reportRepository)

      expect(isHidden({ id: 'x'.repeat(64), pubkey: 'a'.repeat(64) })).to.be.true
    })

    it('logs and continues if the initial DB read fails, without throwing', async () => {
      const reportRepository = {
        findActionableTargets: Sinon.stub().rejects(new Error('db down')),
      } as unknown as IReportRepository

      await expect(startHiddenContentCache(reportRepository)).to.eventually.be.fulfilled
    })

    it('periodically re-reads the DB and reconciles the in-memory set', async () => {
      const clock = Sinon.useFakeTimers()
      try {
        const findActionableTargetsStub = Sinon.stub()
        findActionableTargetsStub.onCall(0).resolves([{ reportedPubkey: 'a'.repeat(64), reportedEventId: null }])
        findActionableTargetsStub.onCall(1).resolves([{ reportedPubkey: 'b'.repeat(64), reportedEventId: null }])
        const reportRepository = { findActionableTargets: findActionableTargetsStub } as unknown as IReportRepository

        await startHiddenContentCache(reportRepository, 1000)
        expect(isHidden({ id: 'x'.repeat(64), pubkey: 'a'.repeat(64) })).to.be.true

        await clock.tickAsync(1000)

        // Fully replaced by the fresh DB read -- a pruned/no-longer-actionable
        // target does not linger just because it was seen on a prior tick.
        expect(isHidden({ id: 'x'.repeat(64), pubkey: 'a'.repeat(64) })).to.be.false
        expect(isHidden({ id: 'x'.repeat(64), pubkey: 'b'.repeat(64) })).to.be.true
      } finally {
        clock.restore()
      }
    })

    it('stopHiddenContentCache stops further polling', async () => {
      const clock = Sinon.useFakeTimers()
      try {
        const findActionableTargetsStub = Sinon.stub().resolves([])
        const reportRepository = { findActionableTargets: findActionableTargetsStub } as unknown as IReportRepository

        await startHiddenContentCache(reportRepository, 1000)
        stopHiddenContentCache()
        findActionableTargetsStub.resetHistory()

        await clock.tickAsync(5000)

        expect(findActionableTargetsStub.called).to.be.false
      } finally {
        clock.restore()
      }
    })
  })

  describe('resetHiddenContentCache', () => {
    it('clears previously marked targets', () => {
      markActionableTarget({ reportedPubkey: 'a'.repeat(64), reportedEventId: null })
      resetHiddenContentCache()

      expect(isHidden({ id: 'z'.repeat(64), pubkey: 'a'.repeat(64) })).to.be.false
    })
  })
})
