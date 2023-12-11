import { Pubkey, Secret } from './base'
import { EventKinds } from '../constants/base'
import { MessageType } from './messages'
import { SubscriptionFilter } from './subscription'

export interface Info {
  relay_url: string
  name: string
  description: string
  pubkey: string
  contact: string
}

export interface Network {
  maxPayloadSize?: number
  remoteIpHeader?: string
}

export interface RateLimit {
  description?: string
  period: number
  rate: number
}

export interface EventIdLimits {
  minLeadingZeroBits?: number
}

export interface PubkeyLimits {
  minBalance: bigint
  minLeadingZeroBits: number
  whitelist?: Pubkey[]
  blacklist?: Pubkey[]
}

export type EventKindsRange = [EventKinds, EventKinds]

export interface EventRateLimit extends RateLimit {
  kinds?: (EventKinds | [EventKinds, EventKinds])[]
}

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

export interface ContentLimits {
  description?: string
  kinds?: (EventKinds | EventKindsRange)[]
  /**
   * Maximum number of characters allowed on events
   */
  maxLength?: number
}

export interface EventWhitelists {
  pubkeys?: Pubkey[]
  ipAddresses?: string[]
}

export interface EventLimits {
  eventId?: EventIdLimits
  pubkey?: PubkeyLimits
  kind?: KindLimits
  createdAt?: CreatedAtLimits
  content?: ContentLimits | ContentLimits[]
  rateLimits?: EventRateLimit[]
  whitelists?: EventWhitelists
}

export interface ClientSubscriptionLimits {
  maxSubscriptions?: number
  maxFilters?: number
  maxFilterValues?: number
  maxLimit?: number
  minPrefixLength?: number
  maxSubscriptionIdLength?: number
}

export interface ClientLimits {
  subscription?: ClientSubscriptionLimits
}

export interface MessageRateLimit extends RateLimit {
  type?: MessageType
}

export interface MessageLimits {
  rateLimits?: MessageRateLimit[]
  ipWhitelist?: string[]
}

export interface ConnectionLimits {
  rateLimits: RateLimit[]
  ipWhitelist?: string[]
  ipBlacklist?: string[]
}

export interface InvoiceLimits {
  rateLimits: RateLimit[]
  ipWhitelist?: string[]
}

export interface Limits {
  invoice?: InvoiceLimits
  connection?: ConnectionLimits
  client?: ClientLimits
  event?: EventLimits
  message?: MessageLimits
}

export interface Worker {
  count: number
}

export interface FeeScheduleWhitelists {
  pubkeys?: Pubkey[]
  event_kinds?: (EventKinds | [EventKinds, EventKinds])[]
}

export interface FeeSchedule {
  enabled: boolean
  description?: string
  amount: bigint
  whitelists?: FeeScheduleWhitelists
}

export interface FeeSchedules {
  admission: FeeSchedule[]
  publication: FeeSchedule[]
}

export interface Payments {
  enabled: boolean
  processor: keyof PaymentsProcessors
  feeSchedules: FeeSchedules
}

export interface LnurlPaymentsProcessor {
  invoiceURL: string
}

export interface ZebedeePaymentsProcessor {
  baseURL: string
  callbackBaseURL: string
  ipWhitelist: string[]
}

export interface NodelessPaymentsProcessor {
  baseURL: string
  storeId: string
}

export interface LNbitsPaymentsProcessor {
  baseURL: string
  callbackBaseURL: string
}

export interface OpenNodePaymentsProcessor {
  baseURL: string
  callbackBaseURL: string
}

export interface NodelessPaymentsProcessor {
  baseURL: string
  storeId: string
}

export interface PaymentsProcessors {
  lnurl?: LnurlPaymentsProcessor,
  zebedee?: ZebedeePaymentsProcessor
  lnbits?: LNbitsPaymentsProcessor
  nodeless?: NodelessPaymentsProcessor
  opennode?: OpenNodePaymentsProcessor
}

export interface Local {
  secret: Secret
}

export interface Remote {
  secret: Secret
}

export interface Mirror {
  address: string
  filters?: SubscriptionFilter[]
  secret?: Secret
}

export interface Mirroring {
  static?: Mirror[]
}

export interface Settings {
  info: Info
  payments?: Payments
  paymentsProcessors?: PaymentsProcessors
  network: Network
  workers?: Worker
  limits?: Limits
  mirroring?: Mirroring
}
