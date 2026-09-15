import { EventId, Pubkey, Tag } from '../@types/base'
import { EventKinds, EventTags } from '../constants/base'
import { Event } from '../@types/event'
import { ReportType } from '../@types/report'

export const isReportEvent = (event: Event): boolean => event.kind === EventKinds.REPORT

const REPORT_TYPES = new Set<string>(Object.values(ReportType))

const isValidReportType = (value: string | undefined): value is ReportType =>
  typeof value === 'string' && REPORT_TYPES.has(value)

const HEX64_PATTERN = /^[0-9a-f]{64}$/i

// The persistence path hex-decodes this straight into a fixed-width binary
// column (toBuffer/Buffer.from(..., 'hex')) -- an arbitrary or malformed tag
// value would silently become a truncated/empty byte string instead of a
// queryable 64-character identifier, so it's rejected here instead.
const isValidHex64 = (value: string | undefined): value is string =>
  typeof value === 'string' && HEX64_PATTERN.test(value)

export interface ReportTarget {
  reportedPubkey: Pubkey | null
  reportedEventId: EventId | null
  reportType: ReportType
}

// NIP-56: the report type is the 3rd element of the tag identifying what's
// being reported. A p tag and an e tag are separate claims (report this
// pubkey, report this event) that happen to travel in the same event -- when
// they share a type (the common case: reporting one piece of content and its
// author for the same reason) they collapse into a single target; when their
// types disagree, each keeps its own type as its own target rather than one
// silently overwriting the other's.
export const extractReportTargets = (tags: Tag[]): ReportTarget[] => {
  const pTag = tags.find((tag) => tag[0] === EventTags.Pubkey && tag.length >= 2 && isValidHex64(tag[1]))
  const eTag = tags.find((tag) => tag[0] === EventTags.Event && tag.length >= 2 && isValidHex64(tag[1]))

  const pType = isValidReportType(pTag?.[2]) ? pTag![2] : undefined
  const eType = isValidReportType(eTag?.[2]) ? eTag![2] : undefined

  if (!pTag && !eTag) {
    return [{ reportedPubkey: null, reportedEventId: null, reportType: ReportType.OTHER }]
  }

  if (pTag && eTag) {
    // Only a genuine disagreement (both sides carry an explicit, different
    // type) splits into two targets; one side simply omitting a type isn't a
    // conflict, so it falls back to whichever side did specify one.
    if (pType !== undefined && eType !== undefined && pType !== eType) {
      return [
        { reportedPubkey: null, reportedEventId: eTag[1], reportType: eType },
        { reportedPubkey: pTag[1], reportedEventId: null, reportType: pType },
      ]
    }

    return [{ reportedPubkey: pTag[1], reportedEventId: eTag[1], reportType: eType ?? pType ?? ReportType.OTHER }]
  }

  if (eTag) {
    return [{ reportedPubkey: null, reportedEventId: eTag[1], reportType: eType ?? ReportType.OTHER }]
  }

  return [{ reportedPubkey: pTag![1], reportedEventId: null, reportType: pType ?? ReportType.OTHER }]
}
