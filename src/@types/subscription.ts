import { EventKinds } from '../constants/base'
import { Pubkey } from './base'
import { EventId } from './event'

export type SubscriptionId = string

export interface SubscriptionFilter {
  ids?: EventId[]
  kinds?: EventKinds[]
  since?: number
  until?: number
  authors?: Pubkey[]
  limit?: number
  [key: `#${string}`]: string[]
}
