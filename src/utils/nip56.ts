import { EventId, Pubkey, Tag } from '../@types/base'
import { Event } from '../@types/event'
import { ReportType } from '../@types/report'
import { EventKinds, EventTags } from '../constants/base'
import { createLogger } from '../factories/logger-factory'

const logger = createLogger('nip56')

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

const targetTypeOf = (tag: Tag): ReportType => (isValidReportType(tag[2]) ? tag[2] : ReportType.OTHER)

// A single report event can legitimately carry more than one p/e tag (e.g.
// a moderator batch-reporting a raid of spam accounts in one event); cap how
// many targets one event can produce so a pathological event can't fan out
// into an unbounded number of rows, while staying well above any realistic
// legitimate batch so a genuine report isn't silently truncated.
const MAX_TARGETS_PER_EVENT = 100

// NIP-56: the report type is the 3rd element of the tag identifying what's
// being reported. A p tag and an e tag are separate claims (report this
// pubkey, report this event) that happen to travel in the same event -- when
// the *first* p tag and *first* e tag share a type (the common case:
// reporting one piece of content and its author for the same reason) they
// collapse into a single target; when their types disagree, each keeps its
// own type as its own target rather than one silently overwriting the
// other's. Any additional p/e tags beyond the first pair are independent,
// single-field targets in their own right.
export const extractReportTargets = (tags: Tag[]): ReportTarget[] => {
  const pTags = tags.filter((tag) => tag[0] === EventTags.Pubkey && tag.length >= 2 && isValidHex64(tag[1]))
  const eTags = tags.filter((tag) => tag[0] === EventTags.Event && tag.length >= 2 && isValidHex64(tag[1]))

  if (!pTags.length && !eTags.length) {
    return [{ reportedPubkey: null, reportedEventId: null, reportType: ReportType.OTHER }]
  }

  const [pTag, ...extraPTags] = pTags
  const [eTag, ...extraETags] = eTags

  const targets: ReportTarget[] = []

  if (pTag && eTag) {
    const pType = isValidReportType(pTag[2]) ? pTag[2] : undefined
    const eType = isValidReportType(eTag[2]) ? eTag[2] : undefined

    // Only a genuine disagreement (both sides carry an explicit, different
    // type) splits into two targets; one side simply omitting a type isn't a
    // conflict, so it falls back to whichever side did specify one.
    if (pType !== undefined && eType !== undefined && pType !== eType) {
      targets.push({ reportedPubkey: null, reportedEventId: eTag[1], reportType: eType })
      targets.push({ reportedPubkey: pTag[1], reportedEventId: null, reportType: pType })
    } else {
      targets.push({
        reportedPubkey: pTag[1],
        reportedEventId: eTag[1],
        reportType: eType ?? pType ?? ReportType.OTHER,
      })
    }
  } else if (eTag) {
    targets.push({ reportedPubkey: null, reportedEventId: eTag[1], reportType: targetTypeOf(eTag) })
  } else if (pTag) {
    targets.push({ reportedPubkey: pTag[1], reportedEventId: null, reportType: targetTypeOf(pTag) })
  }

  for (const tag of extraPTags) {
    targets.push({ reportedPubkey: tag[1], reportedEventId: null, reportType: targetTypeOf(tag) })
  }
  for (const tag of extraETags) {
    targets.push({ reportedPubkey: null, reportedEventId: tag[1], reportType: targetTypeOf(tag) })
  }

  if (targets.length > MAX_TARGETS_PER_EVENT) {
    logger.error(
      'report event carries %d targets, exceeding the %d-target cap; dropping the rest',
      targets.length,
      MAX_TARGETS_PER_EVENT,
    )
    return targets.slice(0, MAX_TARGETS_PER_EVENT)
  }

  return targets
}
