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
  minLeadingZeroBits?: number
}

interface PubkeyLimits {
  minLeadingZeroBits: number
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
  maxNegativeDelta?: number
  /**
   * Maximum number of seconds allowed after the current unix timestamp
   */
  maxPositiveDelta?: number
}

interface EventLimits {
  eventId?: EventIdLimits
  pubkey?: PubkeyLimits
  kind?: KindLimits
  createdAt?: CreatedAtLimits
}

interface ClientSubscriptionLimits {
  maxSubscriptions?: number
  maxFilters?: number
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
