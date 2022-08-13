import { EventKinds } from '../constants/base'
import { Pubkey } from './base'

interface Info {
  relay_url?: string
  name?: string
  description?: string
  pubkey?: string
  contact?: string
}

interface EventIdLimits {
  minimumZeroBits?: number
}

interface PubkeyLimits {
  whitelist?: Pubkey[]
  blacklist?: Pubkey[]
}

interface KindLimits {
  whitelist?: EventKinds[]
  blacklist?: EventKinds[]
}

interface CreatedAtLimits {
  /**
   * Maximum number of seconds allowed before the current unix timestamp
   */
  maximumNegativeDelta?: number
  /**
   * Maximum number of seconds allowed after the current unix timestamp
   */
  maximumPositiveDelta?: number
}

interface EventLimits {
  eventId?: EventIdLimits
  pubkey?: PubkeyLimits
  kind?: KindLimits
  createdAt?: CreatedAtLimits
}

interface ClientSubscriptionLimits {
  maximumCount?: number
  maximumFilters?: number
}

interface ClientLimits {
  subscription?: ClientSubscriptionLimits
}

interface Limits {
  client?: ClientLimits
  event?: EventLimits
}

export interface ISettings {
  info: Info
  limits?: Limits
}
