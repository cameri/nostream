import { EventKinds } from '../constants/base'
import { Pubkey } from './base'

export interface Info {
  relay_url?: string
  name?: string
  description?: string
  pubkey?: string
  contact?: string
}

export interface EventIdLimits {
  minLeadingZeroBits?: number
}

export interface PubkeyLimits {
  minLeadingZeroBits: number
  whitelist?: Pubkey[]
  blacklist?: Pubkey[]
}

export type EventKindsRange = [EventKinds, EventKinds]

export interface KindLimits {
  whitelist?: (EventKinds | EventKindsRange)[]
  blacklist?: (EventKinds | EventKindsRange)[]
}

export interface CreatedAtLimits {
  /**
   * Maximum number of seconds allowed before the current unix timestamp
   */
  maxNegativeDelta?: number
  /**
   * Maximum number of seconds allowed after the current unix timestamp
   */
  maxPositiveDelta?: number
}

export interface EventLimits {
  eventId?: EventIdLimits
  pubkey?: PubkeyLimits
  kind?: KindLimits
  createdAt?: CreatedAtLimits
}

export interface ClientSubscriptionLimits {
  maxSubscriptions?: number
  maxFilters?: number
}

export interface ClientLimits {
  subscription?: ClientSubscriptionLimits
}

export interface Limits {
  client?: ClientLimits
  event?: EventLimits
}

export interface ISettings {
  info: Info
  limits?: Limits
}
