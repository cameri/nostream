import { EventId, Pubkey } from './base'
import { EventKinds } from '../constants/base'

export type SubscriptionId = string

export interface SubscriptionFilter {
  ids?: EventId[]
  kinds?: (EventKinds | number)[]
  since?: number
  until?: number
  authors?: Pubkey[]
  limit?: number
  [key: `#${string}`]: string[]
}
