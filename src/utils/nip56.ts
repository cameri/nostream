import { EventId, Pubkey, Tag } from '../@types/base'
import { EventKinds, EventTags } from '../constants/base'
import { Event } from '../@types/event'
import { ReportType } from '../@types/report'

export const isReportEvent = (event: Event): boolean => event.kind === EventKinds.REPORT

const REPORT_TYPES = new Set<string>(Object.values(ReportType))

const isValidReportType = (value: string | undefined): value is ReportType =>
  typeof value === 'string' && REPORT_TYPES.has(value)

export interface ReportTarget {
  reportedPubkey: Pubkey | null
  reportedEventId: EventId | null
  reportType: ReportType
}

// NIP-56: a report event carries the report type as the 3rd element of the
// tag identifying what's being reported -- an "e" tag (specific event) takes
// precedence over a "p" tag (pubkey) when both are present and disagree,
// since reporting a specific event is the more precise target.
export const extractReportTarget = (tags: Tag[]): ReportTarget => {
  const pTag = tags.find((tag) => tag[0] === EventTags.Pubkey && tag.length >= 2)
  const eTag = tags.find((tag) => tag[0] === EventTags.Event && tag.length >= 2)
  const rawType = eTag?.[2] ?? pTag?.[2]

  return {
    reportedPubkey: pTag?.[1] ?? null,
    reportedEventId: eTag?.[1] ?? null,
    reportType: isValidReportType(rawType) ? rawType : ReportType.OTHER,
  }
}
