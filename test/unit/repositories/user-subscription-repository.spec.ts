import * as chai from 'chai'
import knex from 'knex'

import { DatabaseClient } from '../../../src/@types/base'
import { DBUserSubscription, SubscriptionStatus } from '../../../src/@types/user-subscription'
import { UserSubscriptionRepository } from '../../../src/repositories/user-subscription-repository'

const { expect } = chai

describe('UserSubscriptionRepository', () => {
  const pubkeyHex = '22e804d26ed16b68db5259e78449e96dab5d464c8f470bda3eb1a70467f2c793'
  const start = new Date('2026-01-01T00:00:00.000Z')
  const end = new Date('2026-01-31T00:00:00.000Z')

  const row: DBUserSubscription = {
    pubkey: Buffer.from(pubkeyHex, 'hex'),
    plan_id: 'basic',
    status: SubscriptionStatus.ACTIVE,
    current_period_start: start,
    current_period_end: end,
    grace_ends_at: null,
    cancel_at_period_end: false,
    created_at: start,
    updated_at: start,
  }

  const real = knex({ client: 'pg' })
  let sql: string[]

  // A client that builds real knex queries, records the SQL they would run and answers with `result`.
  const clientReturning = (result: unknown): DatabaseClient =>
    ((table: string) => {
      const builder: any = real(table)
      builder.then = (resolve: (value: unknown) => unknown) => {
        sql.push(builder.toString())
        return Promise.resolve(result).then(resolve)
      }
      return builder
    }) as unknown as DatabaseClient

  let repository: UserSubscriptionRepository

  beforeEach(() => {
    sql = []
    repository = new UserSubscriptionRepository({} as DatabaseClient)
  })

  describe('.findByPubkey', () => {
    it('returns undefined when the pubkey has no subscription', async () => {
      expect(await repository.findByPubkey(pubkeyHex, clientReturning([]))).to.equal(undefined)
    })

    it('maps the row to a UserSubscription and queries by the pubkey bytes', async () => {
      const subscription = await repository.findByPubkey(pubkeyHex, clientReturning([row]))

      expect(subscription).to.deep.equal({
        pubkey: pubkeyHex,
        planId: 'basic',
        status: SubscriptionStatus.ACTIVE,
        currentPeriodStart: start,
        currentPeriodEnd: end,
        graceEndsAt: null,
        cancelAtPeriodEnd: false,
        createdAt: start,
        updatedAt: start,
      })
      expect(sql[0]).to.include('from "user_subscriptions"')
      expect(sql[0]).to.include(`"pubkey" = X'${pubkeyHex}'`)
    })

    it('keeps a never-ending subscription as a null period end', async () => {
      const subscription = await repository.findByPubkey(
        pubkeyHex,
        clientReturning([{ ...row, plan_id: 'grandfathered', current_period_end: null }]),
      )

      expect(subscription?.currentPeriodEnd).to.equal(null)
    })
  })

  describe('.upsert', () => {
    const subscription = {
      pubkey: pubkeyHex,
      planId: 'basic',
      status: SubscriptionStatus.ACTIVE,
      currentPeriodStart: start,
      currentPeriodEnd: end,
      graceEndsAt: null,
      cancelAtPeriodEnd: false,
    }

    it('inserts or updates the row for the pubkey', async () => {
      await repository.upsert(subscription, clientReturning({ rowCount: 1 }))

      expect(sql[0]).to.include('insert into "user_subscriptions"')
      expect(sql[0]).to.include(`X'${pubkeyHex}'`)
      expect(sql[0]).to.include('on conflict ("pubkey") do update set')
    })

    it('updates the subscription but never the pubkey or created_at', async () => {
      await repository.upsert(subscription, clientReturning({ rowCount: 1 }))

      const update = sql[0].split('do update set')[1]
      for (const column of [
        'plan_id',
        'status',
        'current_period_start',
        'current_period_end',
        'grace_ends_at',
        'cancel_at_period_end',
        'updated_at',
      ]) {
        expect(update, column).to.include(`"${column}" = excluded."${column}"`)
      }
      expect(update).to.not.include('"pubkey"')
      expect(update).to.not.include('"created_at"')
    })

    it('returns the number of affected rows', async () => {
      expect(await repository.upsert(subscription, clientReturning({ rowCount: 1 }))).to.equal(1)
    })
  })

  describe('.findDueForRenewal', () => {
    it('selects active subscriptions that are not cancelling and end by the cut-off', async () => {
      const subscriptions = await repository.findDueForRenewal(end, undefined, clientReturning([row]))

      expect(subscriptions).to.have.length(1)
      expect(sql[0]).to.include(`"status" = 'active'`)
      expect(sql[0]).to.include('"cancel_at_period_end" = false')
      expect(sql[0]).to.include('"current_period_end" is not null')
      expect(sql[0]).to.include(`"current_period_end" <= '2026-01-31`)
      expect(sql[0]).to.include('order by "current_period_end" asc')
      expect(sql[0]).to.include('limit 10')
    })

    it('honours the limit', async () => {
      await repository.findDueForRenewal(end, 3, clientReturning([]))

      expect(sql[0]).to.include('limit 3')
    })
  })

  describe('.findPeriodEnded', () => {
    it('selects active and renewal-pending subscriptions whose period has ended', async () => {
      await repository.findPeriodEnded(end, undefined, clientReturning([row]))

      expect(sql[0]).to.include(`"status" in ('active', 'renewal_pending')`)
      expect(sql[0]).to.include('"current_period_end" is not null')
      expect(sql[0]).to.include(`"current_period_end" <= '2026-01-31`)
      expect(sql[0]).to.include('limit 10')
    })
  })

  describe('.findGraceEnded', () => {
    it('selects past-due subscriptions whose grace period has ended', async () => {
      await repository.findGraceEnded(
        end,
        undefined,
        clientReturning([{ ...row, status: SubscriptionStatus.PAST_DUE }]),
      )

      expect(sql[0]).to.include(`"status" = 'past_due'`)
      expect(sql[0]).to.include('"grace_ends_at" is not null')
      expect(sql[0]).to.include(`"grace_ends_at" <= '2026-01-31`)
      expect(sql[0]).to.include('order by "grace_ends_at" asc')
    })
  })
})
