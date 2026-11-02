import { expect } from 'chai'

import { GRANDFATHERED_PLAN_ID, SubscriptionStatus, UserSubscription } from '../../../src/@types/user-subscription'
import {
  applyPayment,
  areSubscriptionsEnabled,
  endPeriod,
  findSubscriptionPlan,
  getAccessEndsAt,
  hasSubscriptionAccess,
} from '../../../src/utils/subscription'
import { Settings, SubscriptionPlan } from '../../../src/@types/settings'

const DAY = 86_400_000
const NOW = new Date('2026-06-15T00:00:00Z')
const at = (offsetMs: number) => new Date(NOW.getTime() + offsetMs)

const plan: SubscriptionPlan = {
  id: 'basic',
  amount: 1_000_000n,
  intervalSeconds: 30 * 86_400,
  graceSeconds: 3 * 86_400,
}

const subscription = (overrides: Partial<UserSubscription> = {}): UserSubscription => ({
  pubkey: 'a'.repeat(64),
  planId: 'basic',
  status: SubscriptionStatus.ACTIVE,
  currentPeriodStart: at(-10 * DAY),
  currentPeriodEnd: at(20 * DAY),
  graceEndsAt: null,
  cancelAtPeriodEnd: false,
  createdAt: at(-10 * DAY),
  updatedAt: at(-10 * DAY),
  ...overrides,
})

describe('subscription utils', () => {
  describe('areSubscriptionsEnabled', () => {
    const settings = (payments: unknown) => ({ payments }) as unknown as Settings

    it('is on only when payments are enabled and a plan is configured', () => {
      expect(areSubscriptionsEnabled(settings({ enabled: true, subscriptionPlans: [plan] }))).to.equal(true)
      expect(areSubscriptionsEnabled(settings({ enabled: false, subscriptionPlans: [plan] }))).to.equal(false)
      expect(areSubscriptionsEnabled(settings({ enabled: true, subscriptionPlans: [] }))).to.equal(false)
      expect(areSubscriptionsEnabled(settings({ enabled: true }))).to.equal(false)
      expect(areSubscriptionsEnabled({} as Settings)).to.equal(false)
    })
  })

  describe('findSubscriptionPlan', () => {
    const settings = { payments: { enabled: true, subscriptionPlans: [plan] } } as unknown as Settings

    it('finds a plan by id', () => {
      expect(findSubscriptionPlan(settings, 'basic')).to.equal(plan)
    })

    it('returns undefined for an unknown, empty or missing id', () => {
      expect(findSubscriptionPlan(settings, 'gold')).to.equal(undefined)
      expect(findSubscriptionPlan(settings, '')).to.equal(undefined)
      expect(findSubscriptionPlan(settings, null)).to.equal(undefined)
      expect(findSubscriptionPlan(settings, undefined)).to.equal(undefined)
    })
  })

  describe('hasSubscriptionAccess', () => {
    it('keeps access for a user with no subscription row', () => {
      expect(hasSubscriptionAccess(undefined, NOW)).to.equal(true)
    })

    it('keeps access on a subscription that never ends', () => {
      const grandfathered = subscription({ planId: GRANDFATHERED_PLAN_ID, currentPeriodEnd: null })

      expect(hasSubscriptionAccess(grandfathered, NOW)).to.equal(true)
    })

    it('keeps access until the period ends, whatever the sweep has done', () => {
      expect(hasSubscriptionAccess(subscription({ currentPeriodEnd: at(1) }), NOW)).to.equal(true)
      expect(hasSubscriptionAccess(subscription({ currentPeriodEnd: at(0) }), NOW)).to.equal(false)
      expect(hasSubscriptionAccess(subscription({ currentPeriodEnd: at(-1) }), NOW)).to.equal(false)
    })

    it('keeps access while a renewal is pending and the period still runs', () => {
      const pending = subscription({ status: SubscriptionStatus.RENEWAL_PENDING, currentPeriodEnd: at(DAY) })

      expect(hasSubscriptionAccess(pending, NOW)).to.equal(true)
    })

    it('keeps access through the grace period and loses it when grace ends', () => {
      const pastDue = (graceEndsAt: Date) =>
        subscription({
          status: SubscriptionStatus.PAST_DUE,
          currentPeriodEnd: at(-2 * DAY),
          graceEndsAt,
        })

      expect(hasSubscriptionAccess(pastDue(at(DAY)), NOW)).to.equal(true)
      expect(hasSubscriptionAccess(pastDue(at(0)), NOW)).to.equal(false)
    })

    it('loses access once expired, even if the stored period end is in the future', () => {
      const expired = subscription({ status: SubscriptionStatus.EXPIRED, currentPeriodEnd: at(20 * DAY) })

      expect(hasSubscriptionAccess(expired, NOW)).to.equal(false)
    })

    it('keeps access through grace before the sweep has put a lapsed subscription into it', () => {
      const lapsed = subscription({
        status: SubscriptionStatus.ACTIVE,
        currentPeriodEnd: at(-DAY),
        graceEndsAt: at(2 * DAY),
      })

      expect(hasSubscriptionAccess(lapsed, NOW)).to.equal(true)
    })

    it('loses access when a lapsed subscription has no grace', () => {
      const lapsed = subscription({ status: SubscriptionStatus.ACTIVE, currentPeriodEnd: at(-DAY), graceEndsAt: null })

      expect(hasSubscriptionAccess(lapsed, NOW)).to.equal(false)
    })

    it('loses access once the grace end has passed, even if the sweep has not run', () => {
      const lapsed = subscription({
        status: SubscriptionStatus.RENEWAL_PENDING,
        currentPeriodEnd: at(-5 * DAY),
        graceEndsAt: at(-DAY),
      })

      expect(hasSubscriptionAccess(lapsed, NOW)).to.equal(false)
    })
  })

  describe('getAccessEndsAt', () => {
    it('is the period end, the grace end once past due, and nothing when it never ends', () => {
      const periodEnd = at(5 * DAY)
      const graceEndsAt = at(8 * DAY)

      expect(getAccessEndsAt(subscription({ currentPeriodEnd: periodEnd }))).to.deep.equal(periodEnd)
      expect(
        getAccessEndsAt(
          subscription({ status: SubscriptionStatus.PAST_DUE, currentPeriodEnd: periodEnd, graceEndsAt }),
        ),
      ).to.deep.equal(graceEndsAt)
      expect(getAccessEndsAt(subscription({ currentPeriodEnd: null }))).to.equal(undefined)
    })
  })

  describe('applyPayment', () => {
    const pubkey = 'b'.repeat(64)

    it('starts the first period now', () => {
      const result = applyPayment(pubkey, undefined, plan, NOW)

      expect(result).to.deep.equal({
        pubkey,
        planId: 'basic',
        status: SubscriptionStatus.ACTIVE,
        currentPeriodStart: NOW,
        currentPeriodEnd: at(30 * DAY),
        graceEndsAt: at(33 * DAY),
        cancelAtPeriodEnd: false,
      })
    })

    it('extends a running period from its end, so paying early loses no time', () => {
      const existing = subscription({ currentPeriodStart: at(-25 * DAY), currentPeriodEnd: at(5 * DAY) })

      const result = applyPayment(pubkey, existing, plan, NOW)

      expect(result.currentPeriodStart).to.deep.equal(at(5 * DAY))
      expect(result.currentPeriodEnd).to.deep.equal(at(35 * DAY))
      expect(result.status).to.equal(SubscriptionStatus.ACTIVE)
    })

    it('extends from the period end while a renewal is pending', () => {
      const existing = subscription({ status: SubscriptionStatus.RENEWAL_PENDING, currentPeriodEnd: at(2 * DAY) })

      expect(applyPayment(pubkey, existing, plan, NOW).currentPeriodStart).to.deep.equal(at(2 * DAY))
    })

    it('starts now once the period has ended, so the gap is not billed back', () => {
      const pastDue = subscription({
        status: SubscriptionStatus.PAST_DUE,
        currentPeriodEnd: at(-2 * DAY),
        graceEndsAt: at(DAY),
      })
      const expired = subscription({ status: SubscriptionStatus.EXPIRED, currentPeriodEnd: at(-40 * DAY) })

      for (const existing of [pastDue, expired]) {
        const result = applyPayment(pubkey, existing, plan, NOW)

        expect(result.currentPeriodStart).to.deep.equal(NOW)
        expect(result.graceEndsAt).to.deep.equal(at(33 * DAY))
        expect(result.status).to.equal(SubscriptionStatus.ACTIVE)
      }
    })

    it('starts now when moving off the grandfathered plan', () => {
      const grandfathered = subscription({ planId: GRANDFATHERED_PLAN_ID, currentPeriodEnd: null })

      const result = applyPayment(pubkey, grandfathered, plan, NOW)

      expect(result.currentPeriodStart).to.deep.equal(NOW)
      expect(result.currentPeriodEnd).to.deep.equal(at(30 * DAY))
    })

    it('gives a plan with no grace no grace end', () => {
      const result = applyPayment(pubkey, undefined, { ...plan, graceSeconds: 0 }, NOW)

      expect(result.graceEndsAt).to.equal(null)
    })

    it('uses the paid plan, so a plan change takes effect on payment', () => {
      const premium = { ...plan, id: 'premium', intervalSeconds: 7 * 86_400 }

      const result = applyPayment(pubkey, subscription(), premium, NOW)

      expect(result.planId).to.equal('premium')
      expect(result.currentPeriodEnd).to.deep.equal(at(20 * DAY + 7 * DAY))
    })
  })

  describe('endPeriod', () => {
    const ended = subscription({ currentPeriodEnd: at(-DAY) })

    it('puts the subscription into grace counted from the period end', () => {
      expect(endPeriod(ended, plan, NOW)).to.deep.equal({
        status: SubscriptionStatus.PAST_DUE,
        graceEndsAt: at(2 * DAY),
      })
    })

    it('expires straight away when the plan has no grace', () => {
      expect(endPeriod(ended, { ...plan, graceSeconds: 0 }, NOW).status).to.equal(SubscriptionStatus.EXPIRED)
    })

    it('expires straight away when the sweep was late and grace has already passed', () => {
      const longEnded = subscription({ currentPeriodEnd: at(-10 * DAY) })

      expect(endPeriod(longEnded, plan, NOW)).to.deep.equal({ status: SubscriptionStatus.EXPIRED, graceEndsAt: null })
    })
  })
})
