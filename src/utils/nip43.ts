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
