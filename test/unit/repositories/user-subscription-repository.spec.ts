import * as chai from 'chai'
import * as sinon from 'sinon'
import knex from 'knex'
import sinonChai from 'sinon-chai'
import chaiAsPromised from 'chai-as-promised'

import { DatabaseClient } from '../../../src/@types/base'
import { SubscriptionStatus, UserSubscription } from '../../../src/@types/user-subscription'
import { UserSubscriptionRepository } from '../../../src/repositories/user-subscription-repository'

chai.use(sinonChai)
chai.use(chaiAsPromised)

const { expect } = chai

describe('UserSubscriptionRepository', () => {
  let repository: UserSubscriptionRepository
  let sandbox: sinon.SinonSandbox
  let dbClient: DatabaseClient

  const fixedDate = new Date('2026-07-08T00:00:00.000Z')
  const pubkeyHex = '22e804d26ed16b68db5259e78449e96dab5d464c8f470bda3eb1a70467f2c793'
  const subscriptionId = '11111111-1111-4111-8111-111111111111'

  const dbSubscriptionRow = {
    id: subscriptionId,
    pubkey: Buffer.from(pubkeyHex, 'hex'),
    plan_id: 'basic',
    status: SubscriptionStatus.ACTIVE,
    current_period_start: fixedDate,
    current_period_end: new Date('2026-08-08T00:00:00.000Z'),
    grace_until: null as Date | null,
    cancel_at_period_end: false,
    created_at: fixedDate,
    updated_at: fixedDate,
  }

  const testSubscription: UserSubscription = {
    id: subscriptionId,
    pubkey: pubkeyHex,
    planId: 'basic',
    status: SubscriptionStatus.ACTIVE,
    currentPeriodStart: fixedDate,
    currentPeriodEnd: new Date('2026-08-08T00:00:00.000Z'),
    graceUntil: null,
    cancelAtPeriodEnd: false,
    createdAt: fixedDate,
    updatedAt: fixedDate,
  }

  beforeEach(() => {
    sandbox = sinon.createSandbox()
    sandbox.useFakeTimers(fixedDate.getTime())
    dbClient = knex({ client: 'pg' })
    repository = new UserSubscriptionRepository(dbClient)
  })

  afterEach(async () => {
    try {
      await dbClient.destroy()
    } finally {
      sandbox.restore()
    }
  })

  describe('.findByPubkey', () => {
    it('returns undefined when no subscription exists', async () => {
      const selectStub = sandbox.stub().resolves([])
      const client = sandbox.stub().returns({
        where: sandbox.stub().returns({ select: selectStub }),
      }) as unknown as DatabaseClient

      const result = await repository.findByPubkey(pubkeyHex, client)

      expect(result).to.be.undefined
    })

    it('returns a transformed subscription when found', async () => {
      const selectStub = sandbox.stub().resolves([dbSubscriptionRow])
      const client = sandbox.stub().returns({
        where: sandbox.stub().returns({ select: selectStub }),
      }) as unknown as DatabaseClient

      const result = await repository.findByPubkey(pubkeyHex, client)

      expect(result).to.deep.include({
        id: subscriptionId,
        pubkey: pubkeyHex,
        planId: 'basic',
        status: SubscriptionStatus.ACTIVE,
        cancelAtPeriodEnd: false,
      })
    })

    it('queries the user_subscriptions table by pubkey', async () => {
      const whereStub = sandbox.stub().returns({ select: sandbox.stub().resolves([]) })
      const client = sandbox.stub().returns({ where: whereStub }) as unknown as DatabaseClient

      await repository.findByPubkey(pubkeyHex, client)

      expect(client).to.have.been.calledWith('user_subscriptions')
      expect(whereStub).to.have.been.calledWith('pubkey', Buffer.from(pubkeyHex, 'hex'))
    })
  })

  describe('.upsert', () => {
    it('inserts into user_subscriptions with on-conflict merge', async () => {
      const mergeStub = sandbox.stub().resolves()
      const onConflictStub = sandbox.stub().returns({ merge: mergeStub })
      const insertStub = sandbox.stub().returns({ onConflict: onConflictStub })
      const findSelectStub = sandbox.stub().resolves([dbSubscriptionRow])
      const client = sandbox.stub().returns({
        insert: insertStub,
        where: sandbox.stub().returns({ select: findSelectStub }),
      }) as unknown as DatabaseClient

      await repository.upsert(testSubscription, client)

      expect(client).to.have.been.calledWith('user_subscriptions')
      expect(onConflictStub).to.have.been.calledWith('pubkey')
      expect(mergeStub).to.have.been.calledOnce
    })

    it('returns the saved subscription', async () => {
      const mergeStub = sandbox.stub().resolves()
      const onConflictStub = sandbox.stub().returns({ merge: mergeStub })
      const insertStub = sandbox.stub().returns({ onConflict: onConflictStub })
      const findSelectStub = sandbox.stub().resolves([dbSubscriptionRow])
      const client = sandbox.stub().returns({
        insert: insertStub,
        where: sandbox.stub().returns({ select: findSelectStub }),
      }) as unknown as DatabaseClient

      const result = await repository.upsert(testSubscription, client)

      expect(result.planId).to.equal('basic')
      expect(result.pubkey).to.equal(pubkeyHex)
    })
  })

  describe('.findDueForRenewal', () => {
    it('queries active and renewal_pending subscriptions ending before the cutoff', async () => {
      const selectStub = sandbox.stub().resolves([dbSubscriptionRow])
      const limitStub = sandbox.stub().returns({ select: selectStub })
      const orderByStub = sandbox.stub().returns({ limit: limitStub })
      const wherePeriodEndStub = sandbox.stub().returns({ orderBy: orderByStub })
      const whereInStub = sandbox.stub().returns({ where: wherePeriodEndStub })
      const client = sandbox.stub().returns({ whereIn: whereInStub }) as unknown as DatabaseClient

      const cutoff = new Date('2026-08-01T00:00:00.000Z')
      const result = await repository.findDueForRenewal(cutoff, 25, client)

      expect(client).to.have.been.calledWith('user_subscriptions')
      expect(whereInStub).to.have.been.calledWith('status', [
        SubscriptionStatus.ACTIVE,
        SubscriptionStatus.RENEWAL_PENDING,
      ])
      expect(wherePeriodEndStub).to.have.been.calledWith('current_period_end', '<=', cutoff)
      expect(limitStub).to.have.been.calledWith(25)
      expect(result).to.have.length(1)
      expect(result[0].planId).to.equal('basic')
    })
  })

  describe('.findExpired', () => {
    it('queries subscriptions that are past due or past period end', async () => {
      const selectStub = sandbox.stub().resolves([dbSubscriptionRow])
      const limitStub = sandbox.stub().returns({ select: selectStub })
      const orderByStub = sandbox.stub().returns({ limit: limitStub })
      const orWhereStub = sandbox.stub().returns({ orderBy: orderByStub })
      const whereStub = sandbox.stub().returns({ orWhere: orWhereStub })
      const client = sandbox.stub().returns({ where: whereStub }) as unknown as DatabaseClient

      const asOf = new Date('2026-09-01T00:00:00.000Z')
      const result = await repository.findExpired(asOf, 10, client)

      expect(client).to.have.been.calledWith('user_subscriptions')
      expect(whereStub).to.have.been.calledOnce
      expect(orWhereStub).to.have.been.calledOnce
      expect(limitStub).to.have.been.calledWith(10)
      expect(result).to.have.length(1)
    })
  })
})
