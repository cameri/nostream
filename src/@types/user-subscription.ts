import { Pubkey } from './base'

export enum SubscriptionStatus {
  ACTIVE = 'active',
  RENEWAL_PENDING = 'renewal_pending',
  PAST_DUE = 'past_due',
  EXPIRED = 'expired',
}

/** Plan id of the subscriptions created for users admitted before subscription plans existed. */
export const GRANDFATHERED_PLAN_ID = 'grandfathered'

export interface UserSubscription {
  pubkey: Pubkey
  planId: string
  status: SubscriptionStatus
  currentPeriodStart: Date
  /** Null when the subscription never ends. */
  currentPeriodEnd: Date | null
  graceEndsAt: Date | null
  cancelAtPeriodEnd: boolean
  createdAt: Date
  updatedAt: Date
}

export interface DBUserSubscription {
  pubkey: Buffer
  plan_id: string
  status: SubscriptionStatus
  current_period_start: Date
  current_period_end: Date | null
  grace_ends_at: Date | null
  cancel_at_period_end: boolean
  created_at: Date
  updated_at: Date
}
