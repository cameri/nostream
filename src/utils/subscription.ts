import { Pubkey } from '../@types/base'
import { Settings, SubscriptionPlan } from '../@types/settings'
import { GRANDFATHERED_PLAN_ID, SubscriptionStatus, UserSubscription } from '../@types/user-subscription'

/** How long before a period ends the relay issues the renewal invoice. */
export const RENEWAL_LEAD_SECONDS = 3 * 24 * 60 * 60

export const getSubscriptionPlans = (settings: Settings): SubscriptionPlan[] =>
  settings.payments?.subscriptionPlans ?? []

/** Plans only take effect while payments are on, so an operator can switch them off without editing the list. */
export const areSubscriptionsEnabled = (settings: Settings): boolean =>
  settings.payments?.enabled === true && getSubscriptionPlans(settings).length > 0

export const findSubscriptionPlan = (settings: Settings, planId: string | null | undefined) =>
  planId ? getSubscriptionPlans(settings).find((plan) => plan.id === planId) : undefined

/**
 * When access ends, or undefined if it never does.
 *
 * Judged from the dates rather than the stored status, so a user is not locked out or kept
 * in by a sweep that has not run yet. A paid period carries its grace end from the payment,
 * so access runs on through grace even before the sweep marks the subscription past due.
 */
export const getAccessEndsAt = (subscription: UserSubscription): Date | undefined => {
  if (subscription.status === SubscriptionStatus.EXPIRED) {
    return new Date(0)
  }

  if (!subscription.currentPeriodEnd) {
    return undefined
  }

  return subscription.graceEndsAt ?? subscription.currentPeriodEnd
}

/**
 * Users with no row are admitted users from before plans were enabled, or admitted without
 * paying (invite code, NIP-43), so they keep access.
 */
export const hasSubscriptionAccess = (subscription: UserSubscription | undefined, now: Date): boolean => {
  if (!subscription) {
    return true
  }

  const endsAt = getAccessEndsAt(subscription)

  return !endsAt || endsAt.getTime() > now.getTime()
}

/**
 * The subscription after a payment for `plan`. A payment made while access is still running
 * extends it from the current period end, so paying early costs nothing. After access has
 * lapsed, or on the never-ending grandfathered plan, the new period starts now.
 */
export const applyPayment = (
  pubkey: Pubkey,
  existing: UserSubscription | undefined,
  plan: SubscriptionPlan,
  now: Date,
): Omit<UserSubscription, 'createdAt' | 'updatedAt'> => {
  const stillRunning =
    existing &&
    existing.planId !== GRANDFATHERED_PLAN_ID &&
    existing.currentPeriodEnd &&
    (existing.status === SubscriptionStatus.ACTIVE || existing.status === SubscriptionStatus.RENEWAL_PENDING) &&
    existing.currentPeriodEnd.getTime() > now.getTime()

  const periodStart = stillRunning ? (existing.currentPeriodEnd as Date) : now
  const periodEnd = new Date(periodStart.getTime() + plan.intervalSeconds * 1000)

  return {
    pubkey,
    planId: plan.id,
    status: SubscriptionStatus.ACTIVE,
    currentPeriodStart: periodStart,
    currentPeriodEnd: periodEnd,
    graceEndsAt: plan.graceSeconds > 0 ? new Date(periodEnd.getTime() + plan.graceSeconds * 1000) : null,
    cancelAtPeriodEnd: false,
  }
}

/**
 * Where a subscription whose period has ended goes next: straight to expired if the plan has
 * no grace or the grace window has already passed, otherwise into grace.
 */
export const endPeriod = (
  subscription: UserSubscription,
  plan: SubscriptionPlan,
  now: Date,
): Pick<UserSubscription, 'status' | 'graceEndsAt'> => {
  const periodEnd = subscription.currentPeriodEnd as Date
  const graceEndsAt = new Date(periodEnd.getTime() + plan.graceSeconds * 1000)

  if (plan.graceSeconds <= 0 || graceEndsAt.getTime() <= now.getTime()) {
    return { status: SubscriptionStatus.EXPIRED, graceEndsAt: null }
  }

  return { status: SubscriptionStatus.PAST_DUE, graceEndsAt }
}
