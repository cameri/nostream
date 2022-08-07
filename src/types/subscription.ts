import { Pubkey } from 'types'
import { EventId } from './event'

export type SubscriptionId = string

export interface SubscriptionFilter {
  ids?: EventId[]
  kinds?: number[]
  since?: number
  until?: number
  authors?: Pubkey[]
  [key: `#${string}`]: string[]
}
