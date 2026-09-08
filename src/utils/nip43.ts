import { Event } from '../@types/event'
import { EventKinds, EventTags } from '../constants/base'

export const isNip43JoinRequest = (event: Event): boolean =>
  event.kind === EventKinds.NIP43_JOIN_REQUEST

export const isNip43LeaveRequest = (event: Event): boolean =>
  event.kind === EventKinds.NIP43_LEAVE_REQUEST

export const getClaimTag = (event: Event): string | undefined => {
  const tag = event.tags.find((t) => t.length >= 2 && t[0] === EventTags.Claim)
  return tag?.[1]
}

// NIP-43 requires join/leave request created_at to be "now, plus or minus a few
// minutes". Same tolerance as the NIP-42 auth handler.
const MAX_TIMESTAMP_DELTA_SECONDS = 600

export const isNip43RequestTimestampValid = (event: Event): boolean =>
  Math.abs(Math.floor(Date.now() / 1000) - event.created_at) <= MAX_TIMESTAMP_DELTA_SECONDS
