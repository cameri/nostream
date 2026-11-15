import { After, Given, Then } from '@cucumber/cucumber'
import { expect } from 'chai'
import { randomBytes, randomUUID } from 'crypto'

import { getMasterDbClient } from '../../../../src/database/client'
import { SettingsStatic } from '../../../../src/utils/settings'

const DAY_MS = 24 * 60 * 60 * 1000
const PLAN_INTERVAL_SECONDS = 30 * 24 * 60 * 60

const readSubscription = async (pubkey: Buffer) => {
  const row = await getMasterDbClient()('user_subscriptions')
    .where('pubkey', pubkey)
    .first('plan_id', 'status', 'current_period_start', 'current_period_end')

  expect(row, 'the subscriber has no subscription').to.exist

  return row
}

Given(
  'the relay sells the plans {string} at {int} sats and {string} at {int} sats',
  function (firstId: string, firstSats: number, secondId: string, secondSats: number) {
    const settings = SettingsStatic._settings as any
    const plan = (id: string, sats: number) => ({
      id,
      amount: BigInt(sats) * 1000n,
      intervalSeconds: PLAN_INTERVAL_SECONDS,
      graceSeconds: DAY_MS / 1000,
    })

    // The OpenNode callback steps restore the settings they replaced once the scenario ends.
    SettingsStatic._settings = {
      ...settings,
      payments: {
        ...settings.payments,
        subscriptionPlans: [plan(firstId, firstSats), plan(secondId, secondSats)],
      },
    }
  },
)

const createSubscriber = async (world: any, subscription?: { planId: string; endsInDays: number }) => {
  const dbClient = getMasterDbClient()
  const pubkey = randomBytes(32)

  await dbClient('users').insert({ pubkey, is_admitted: false })
  world.parameters.subscriberPubkey = pubkey
  world.parameters.subscriberPubkeys = [...(world.parameters.subscriberPubkeys ?? []), pubkey]

  if (!subscription) {
    return
  }

  const now = Date.now()
  const periodEnd = new Date(now + subscription.endsInDays * DAY_MS)
  await dbClient('user_subscriptions').insert({
    pubkey,
    plan_id: subscription.planId,
    status: 'active',
    current_period_start: new Date(now - (30 - subscription.endsInDays) * DAY_MS),
    current_period_end: periodEnd,
    grace_ends_at: new Date(periodEnd.getTime() + DAY_MS),
  })
  await dbClient('users').where('pubkey', pubkey).update({ is_admitted: true })

  world.parameters.subscriptionEndBefore = (await readSubscription(pubkey)).current_period_end as Date
}

Given(
  'a subscriber has a running {string} plan that ends in {int} days',
  async function (planId: string, days: number) {
    await createSubscriber(this, { planId, endsInDays: days })
  },
)

Given('a subscriber without a subscription', async function () {
  await createSubscriber(this)
})

Given(
  'a pending OpenNode invoice for the subscriber for {int} sats on the plan {string} exists',
  async function (sats: number, planId: string) {
    const invoiceId = `integration-subscription-${randomUUID()}`

    await getMasterDbClient()('invoices').insert({
      id: invoiceId,
      pubkey: this.parameters.subscriberPubkey,
      bolt11: 'lnbc210n1integration',
      amount_requested: String(sats),
      unit: 'sats',
      status: 'pending',
      description: 'subscription plan change integration test',
      plan_id: planId,
      expires_at: new Date(Date.now() + 15 * 60 * 1000),
      updated_at: new Date(),
      created_at: new Date(),
    })

    // The OpenNode callback steps post for, and clean up, this invoice.
    this.parameters.openNodeInvoiceId = invoiceId
    this.parameters.openNodeInvoiceIds = [...(this.parameters.openNodeInvoiceIds ?? []), invoiceId]
  },
)

Then('the subscriber is still on the plan {string}', async function (planId: string) {
  const subscription = await readSubscription(this.parameters.subscriberPubkey)

  expect(subscription.plan_id).to.equal(planId)
  // The payment was credited to the running plan, so the subscription is neither restarted nor ended.
  expect(subscription.status).to.equal('active')
})

Then('the subscriber is on the plan {string}', async function (planId: string) {
  const subscription = await readSubscription(this.parameters.subscriberPubkey)

  expect(subscription.plan_id).to.equal(planId)
  expect(subscription.status).to.equal('active')
})

Then("the subscriber's plan ends {float} days later than before", async function (days: number) {
  const subscription = await readSubscription(this.parameters.subscriberPubkey)
  const before = this.parameters.subscriptionEndBefore as Date

  expect(subscription.current_period_end.getTime() - before.getTime()).to.equal(Math.round(days * DAY_MS))
})

Then('the subscriber has been admitted to the relay', async function () {
  const user = await getMasterDbClient()('users').where('pubkey', this.parameters.subscriberPubkey).first('is_admitted')

  expect(user.is_admitted).to.equal(true)
})

After({ tags: '@subscription-plan-change' }, async function () {
  const pubkeys = this.parameters.subscriberPubkeys ?? []
  if (pubkeys.length > 0) {
    // The subscription goes with the user, whose row it references.
    await getMasterDbClient()('users').whereIn('pubkey', pubkeys).delete()
  }

  this.parameters.subscriberPubkey = undefined
  this.parameters.subscriberPubkeys = []
  this.parameters.subscriptionEndBefore = undefined
})
