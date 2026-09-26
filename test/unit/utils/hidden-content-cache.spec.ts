import { expect } from 'chai'
import Sinon from 'sinon'

import { IReportRepository } from '../../../src/@types/repositories'
import {
  isHidden,
  markActionableTarget,
  resetHiddenContentCache,
  warmHiddenContentCache,
} from '../../../src/utils/hidden-content-cache'

describe('hidden-content-cache', () => {
  afterEach(() => {
    resetHiddenContentCache()
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

  describe('warmHiddenContentCache', () => {
    it('marks every actionable target returned by the repository', async () => {
      const reportRepository = {
        findActionableTargets: Sinon.stub().resolves([
          { reportedPubkey: 'a'.repeat(64), reportedEventId: null },
          { reportedPubkey: null, reportedEventId: 'b'.repeat(64) },
        ]),
      } as unknown as IReportRepository

      await warmHiddenContentCache(reportRepository)

      expect(isHidden({ id: 'x'.repeat(64), pubkey: 'a'.repeat(64) })).to.be.true
      expect(isHidden({ id: 'b'.repeat(64), pubkey: 'y'.repeat(64) })).to.be.true
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
