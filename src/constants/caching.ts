export enum CacheAdmissionState {
  ADMITTED = 'admitted',
  BLOCKED_NOT_ADMITTED = 'blocked_not_admitted',
  BLOCKED_INSUFFICIENT_BALANCE = 'blocked_insufficient_balance',
}

export const admissionCacheKey = (pubkey: string): string => `${pubkey}:is-admitted`

/** Holds `plan:<id>` for a pubkey with an active subscription, or `none`. */
export const subscriptionPlanCacheKey = (pubkey: string): string => `${pubkey}:subscription-plan`

export const NO_SUBSCRIPTION_PLAN = 'none'
export const SUBSCRIPTION_PLAN_PREFIX = 'plan:'
