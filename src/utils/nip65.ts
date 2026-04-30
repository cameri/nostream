import { Event, RelayListEntry } from '../@types/event'
import { EventKinds, EventTags } from '../constants/base'

export const isRelayListEvent = (event: Event): boolean => event.kind === EventKinds.RELAY_LIST

export const parseRelayList = (event: Event): RelayListEntry[] =>
  event.tags
    .filter((tag) => tag[0] === EventTags.Relay && tag.length >= 2)
    .map((tag) => ({
      url: tag[1],
      marker: tag[2] === 'read' || tag[2] === 'write' ? tag[2] : undefined,
    }))
