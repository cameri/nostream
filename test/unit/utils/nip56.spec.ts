import { expect } from 'chai'
import { Tag } from '../../../src/@types/base'
import { Event } from '../../../src/@types/event'
import { ReportType } from '../../../src/@types/report'
import { extractReportTargets, isReportEvent } from '../../../src/utils/nip56'

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

  describe('extractReportTargets', () => {
    it('returns a single null/OTHER target when no e/p tags are present', () => {
      expect(extractReportTargets([])).to.deep.equal([
        { reportedPubkey: null, reportedEventId: null, reportType: ReportType.OTHER },
      ])
    })

    it('extracts a reported pubkey and its report type from a p tag', () => {
      const tags = [['p', 'a'.repeat(64), 'impersonation']] as Tag[]
      expect(extractReportTargets(tags)).to.deep.equal([
        { reportedPubkey: 'a'.repeat(64), reportedEventId: null, reportType: ReportType.IMPERSONATION },
      ])
    })

    it('extracts a reported event id and its report type from an e tag', () => {
      const tags = [['e', 'b'.repeat(64), 'spam']] as Tag[]
      expect(extractReportTargets(tags)).to.deep.equal([
        { reportedPubkey: null, reportedEventId: 'b'.repeat(64), reportType: ReportType.SPAM },
      ])
    })

    it('merges p and e tags into one target when they share the same type', () => {
      const tags = [
        ['p', 'a'.repeat(64), 'nudity'],
        ['e', 'b'.repeat(64), 'nudity'],
      ] as Tag[]
      expect(extractReportTargets(tags)).to.deep.equal([
        { reportedPubkey: 'a'.repeat(64), reportedEventId: 'b'.repeat(64), reportType: ReportType.NUDITY },
      ])
    })

    it('splits into two targets, each keeping its own type, when p and e tags disagree', () => {
      const tags = [
        ['p', 'a'.repeat(64), 'impersonation'],
        ['e', 'b'.repeat(64), 'nudity'],
      ] as Tag[]
      expect(extractReportTargets(tags)).to.deep.equal([
        { reportedPubkey: null, reportedEventId: 'b'.repeat(64), reportType: ReportType.NUDITY },
        { reportedPubkey: 'a'.repeat(64), reportedEventId: null, reportType: ReportType.IMPERSONATION },
      ])
    })

    it('merges p and e tags when the e tag has no type but the p tag does', () => {
      const tags = [
        ['p', 'a'.repeat(64), 'malware'],
        ['e', 'b'.repeat(64)],
      ] as Tag[]
      expect(extractReportTargets(tags)).to.deep.equal([
        { reportedPubkey: 'a'.repeat(64), reportedEventId: 'b'.repeat(64), reportType: ReportType.MALWARE },
      ])
    })

    it('merges p and e tags when neither carries a type', () => {
      const tags = [
        ['p', 'a'.repeat(64)],
        ['e', 'b'.repeat(64)],
      ] as Tag[]
      expect(extractReportTargets(tags)).to.deep.equal([
        { reportedPubkey: 'a'.repeat(64), reportedEventId: 'b'.repeat(64), reportType: ReportType.OTHER },
      ])
    })

    it('falls back to OTHER for an unrecognized report type', () => {
      const tags = [['p', 'a'.repeat(64), 'not-a-real-type']] as Tag[]
      expect(extractReportTargets(tags)).to.deep.equal([
        { reportedPubkey: 'a'.repeat(64), reportedEventId: null, reportType: ReportType.OTHER },
      ])
    })

    it('ignores tags shorter than 2 elements', () => {
      const tags = [['p'], ['e']] as Tag[]
      expect(extractReportTargets(tags)).to.deep.equal([
        { reportedPubkey: null, reportedEventId: null, reportType: ReportType.OTHER },
      ])
    })

    it('rejects a p tag value that is not a 64-character hex string', () => {
      const tags = [['p', 'not-hex', 'spam']] as Tag[]
      expect(extractReportTargets(tags)).to.deep.equal([
        { reportedPubkey: null, reportedEventId: null, reportType: ReportType.OTHER },
      ])
    })

    it('rejects an e tag value that is too short to be a valid event id', () => {
      const tags = [['e', 'a'.repeat(63), 'spam']] as Tag[]
      expect(extractReportTargets(tags)).to.deep.equal([
        { reportedPubkey: null, reportedEventId: null, reportType: ReportType.OTHER },
      ])
    })

    it('accepts an uppercase-hex tag value', () => {
      const tags = [['p', 'A'.repeat(64), 'spam']] as Tag[]
      expect(extractReportTargets(tags)).to.deep.equal([
        { reportedPubkey: 'A'.repeat(64), reportedEventId: null, reportType: ReportType.SPAM },
      ])
    })

    it('falls back to a valid p tag when the e tag value is malformed', () => {
      const tags = [
        ['p', 'a'.repeat(64), 'spam'],
        ['e', 'not-hex', 'spam'],
      ] as Tag[]
      expect(extractReportTargets(tags)).to.deep.equal([
        { reportedPubkey: 'a'.repeat(64), reportedEventId: null, reportType: ReportType.SPAM },
      ])
    })

    it('records a target for every additional p tag beyond the first', () => {
      const tags = [
        ['p', 'a'.repeat(64), 'spam'],
        ['p', 'c'.repeat(64), 'malware'],
        ['p', 'd'.repeat(64)],
      ] as Tag[]
      expect(extractReportTargets(tags)).to.deep.equal([
        { reportedPubkey: 'a'.repeat(64), reportedEventId: null, reportType: ReportType.SPAM },
        { reportedPubkey: 'c'.repeat(64), reportedEventId: null, reportType: ReportType.MALWARE },
        { reportedPubkey: 'd'.repeat(64), reportedEventId: null, reportType: ReportType.OTHER },
      ])
    })

    it('records a target for every additional e tag beyond the first', () => {
      const tags = [
        ['e', 'b'.repeat(64), 'nudity'],
        ['e', 'f'.repeat(64), 'illegal'],
      ] as Tag[]
      expect(extractReportTargets(tags)).to.deep.equal([
        { reportedPubkey: null, reportedEventId: 'b'.repeat(64), reportType: ReportType.NUDITY },
        { reportedPubkey: null, reportedEventId: 'f'.repeat(64), reportType: ReportType.ILLEGAL },
      ])
    })

    it('combines a merged first p/e pair with additional independent targets', () => {
      const tags = [
        ['p', 'a'.repeat(64), 'nudity'],
        ['e', 'b'.repeat(64), 'nudity'],
        ['p', 'c'.repeat(64), 'spam'],
      ] as Tag[]
      expect(extractReportTargets(tags)).to.deep.equal([
        { reportedPubkey: 'a'.repeat(64), reportedEventId: 'b'.repeat(64), reportType: ReportType.NUDITY },
        { reportedPubkey: 'c'.repeat(64), reportedEventId: null, reportType: ReportType.SPAM },
      ])
    })

    it('caps the number of targets a single event can produce', () => {
      const tags = Array.from({ length: 25 }, (_, i) => ['p', i.toString(16).padStart(64, '0'), 'spam']) as Tag[]
      const targets = extractReportTargets(tags)
      expect(targets).to.have.lengthOf(20)
    })
  })
})
