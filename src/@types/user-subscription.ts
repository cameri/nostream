import { Pubkey } from './base'

export enum SubscriptionStatus {
  ACTIVE = 'active',
  RENEWAL_PENDING = 'renewal_pending',
  PAST_DUE = 'past_due',
  EXPIRED = 'expired',
  CANCELED = 'canceled',
}

export interface UserSubscription {
  id: string
  pubkey: Pubkey
  planId: string
  status: SubscriptionStatus
  currentPeriodStart: Date
  currentPeriodEnd: Date
  graceUntil: Date | null
  cancelAtPeriodEnd: boolean
  createdAt: Date
  updatedAt: Date
}

export interface DBUserSubscription {
  id: string
  pubkey: Buffer
  plan_id: string
  status: SubscriptionStatus
  current_period_start: Date
  current_period_end: Date
  grace_until: Date | null
  cancel_at_period_end: boolean
  created_at: Date
  updated_at: Date
}
