import { expect } from 'chai'
import { Event } from '../../../src/@types/event'
import { extractReportTarget, isReportEvent } from '../../../src/utils/nip56'
import { ReportType } from '../../../src/@types/report'
import { Tag } from '../../../src/@types/base'

const baseEvent = (): Partial<Event> => ({
  kind: 1984,
  tags: [],
  content: '',
})

describe('NIP-56', () => {
  describe('isReportEvent', () => {
    it('returns true for kind 1984', () => {
      expect(isReportEvent({ ...baseEvent(), kind: 1984 } as Event)).to.equal(true)
    })

    it('returns false for kind 1 (text_note)', () => {
      expect(isReportEvent({ ...baseEvent(), kind: 1 } as Event)).to.equal(false)
    })

    it('returns false for kind 3 (contact_list)', () => {
      expect(isReportEvent({ ...baseEvent(), kind: 3 } as Event)).to.equal(false)
    })
  })

  describe('extractReportTarget', () => {
    it('returns nulls and OTHER type when no e/p tags are present', () => {
      expect(extractReportTarget([])).to.deep.equal({
        reportedPubkey: null,
        reportedEventId: null,
        reportType: ReportType.OTHER,
      })
    })

    it('extracts a reported pubkey and its report type from a p tag', () => {
      const tags = [['p', 'a'.repeat(64), 'impersonation']] as Tag[]
      expect(extractReportTarget(tags)).to.deep.equal({
        reportedPubkey: 'a'.repeat(64),
        reportedEventId: null,
        reportType: ReportType.IMPERSONATION,
      })
    })

    it('extracts a reported event id and its report type from an e tag', () => {
      const tags = [['e', 'b'.repeat(64), 'spam']] as Tag[]
      expect(extractReportTarget(tags)).to.deep.equal({
        reportedPubkey: null,
        reportedEventId: 'b'.repeat(64),
        reportType: ReportType.SPAM,
      })
    })

    it('extracts both when both e and p tags are present, preferring the e tag type', () => {
      const tags = [
        ['p', 'a'.repeat(64), 'impersonation'],
        ['e', 'b'.repeat(64), 'nudity'],
      ] as Tag[]
      expect(extractReportTarget(tags)).to.deep.equal({
        reportedPubkey: 'a'.repeat(64),
        reportedEventId: 'b'.repeat(64),
        reportType: ReportType.NUDITY,
      })
    })

    it('falls back to the p tag type when the e tag has none', () => {
      const tags = [
        ['p', 'a'.repeat(64), 'malware'],
        ['e', 'b'.repeat(64)],
      ] as Tag[]
      expect(extractReportTarget(tags)).to.deep.equal({
        reportedPubkey: 'a'.repeat(64),
        reportedEventId: 'b'.repeat(64),
        reportType: ReportType.MALWARE,
      })
    })

    it('falls back to OTHER for an unrecognized report type', () => {
      const tags = [['p', 'a'.repeat(64), 'not-a-real-type']] as Tag[]
      expect(extractReportTarget(tags).reportType).to.equal(ReportType.OTHER)
    })

    it('ignores tags shorter than 2 elements', () => {
      const tags = [['p'], ['e']] as Tag[]
      expect(extractReportTarget(tags)).to.deep.equal({
        reportedPubkey: null,
        reportedEventId: null,
        reportType: ReportType.OTHER,
      })
    })
  })
})
