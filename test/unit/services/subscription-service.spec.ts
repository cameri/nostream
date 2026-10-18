import chai from 'chai'
import chaiAsPromised from 'chai-as-promised'
import Sinon from 'sinon'
import sinonChai from 'sinon-chai'

chai.use(sinonChai)
chai.use(chaiAsPromised)

import { RENEWAL_LEAD_SECONDS } from '../../../src/utils/subscription'
import { Settings } from '../../../src/@types/settings'
import { SubscriptionService } from '../../../src/services/subscription-service'
import { SubscriptionStatus, UserSubscription } from '../../../src/@types/user-subscription'

const { expect } = chai

const DAY = 86_400_000
const NOW = new Date('2026-06-15T00:00:00Z')
const at = (offsetMs: number) => new Date(NOW.getTime() + offsetMs)
const PUBKEY = 'a'.repeat(64)

const subscription = (overrides: Partial<UserSubscription> = {}): UserSubscription => ({
  pubkey: PUBKEY,
  planId: 'basic',
  status: SubscriptionStatus.ACTIVE,
  currentPeriodStart: at(-28 * DAY),
  currentPeriodEnd: at(2 * DAY),
  graceEndsAt: null,
  cancelAtPeriodEnd: false,
  createdAt: at(-28 * DAY),
  updatedAt: at(-28 * DAY),
  ...overrides,
})

describe('SubscriptionService', () => {
  let sandbox: Sinon.SinonSandbox
  let repository: Record<string, Sinon.SinonStub>
  let paymentsService: { createInvoice: Sinon.SinonStub }
  let currentSettings: Settings
  let service: SubscriptionService

  beforeEach(() => {
    sandbox = Sinon.createSandbox()
    repository = {
      findByPubkey: sandbox.stub().resolves(undefined),
      upsert: sandbox.stub().resolves(1),
      findDueForRenewal: sandbox.stub().resolves([]),
      findPeriodEnded: sandbox.stub().resolves([]),
      findGraceEnded: sandbox.stub().resolves([]),
    }
    paymentsService = { createInvoice: sandbox.stub().resolves({ id: 'invoice-id' }) }
    currentSettings = {
      info: { name: 'test relay' },
      payments: {
        enabled: true,
        subscriptionPlans: [
          { id: 'basic', amount: 1_000_000n, intervalSeconds: 30 * 86_400, graceSeconds: 3 * 86_400 },
        ],
      },
    } as unknown as Settings
    service = new SubscriptionService(repository as any, paymentsService as any, () => currentSettings)
  })

  afterEach(() => {
    sandbox.restore()
  })

  describe('processLifecycle', () => {
    it('does nothing while subscriptions are off', async () => {
      currentSettings = {
        ...currentSettings,
        payments: { enabled: true, subscriptionPlans: [] },
      } as unknown as Settings

      expect(await service.processLifecycle(NOW)).to.equal(0)
      expect(repository.findPeriodEnded).not.to.have.been.called
      expect(repository.findDueForRenewal).not.to.have.been.called
    })

    it('does nothing while payments are off', async () => {
      currentSettings = {
        ...currentSettings,
        payments: { ...currentSettings.payments, enabled: false },
      } as unknown as Settings

      expect(await service.processLifecycle(NOW)).to.equal(0)
      expect(repository.findPeriodEnded).not.to.have.been.called
    })

    describe('renewal invoices', () => {
      it('looks for subscriptions ending within the renewal lead time', async () => {
        await service.processLifecycle(NOW)

        expect(repository.findDueForRenewal).to.have.been.calledOnce
        expect(repository.findDueForRenewal.firstCall.args[0]).to.deep.equal(
          new Date(NOW.getTime() + RENEWAL_LEAD_SECONDS * 1000),
        )
      })

      it('issues an invoice for the plan price and waits for payment', async () => {
        repository.findDueForRenewal.onFirstCall().resolves([subscription()])

        expect(await service.processLifecycle(NOW)).to.equal(1)

        expect(paymentsService.createInvoice).to.have.been.calledOnce
        const [pubkey, amount, description, planId] = paymentsService.createInvoice.firstCall.args
        expect(pubkey).to.equal(PUBKEY)
        expect(amount).to.equal(1_000_000n)
        expect(description).to.contain('test relay').and.contain('basic')
        expect(planId).to.equal('basic')
        expect(repository.upsert).to.have.been.calledOnce
        expect(repository.upsert.firstCall.args[0]).to.include({
          pubkey: PUBKEY,
          status: SubscriptionStatus.RENEWAL_PENDING,
        })
      })

      it('does not change the status when the invoice cannot be created, so the next pass retries', async () => {
        repository.findDueForRenewal.onFirstCall().resolves([subscription()])
        paymentsService.createInvoice.rejects(new Error('processor down'))

        expect(await service.processLifecycle(NOW)).to.equal(0)

        expect(repository.upsert).not.to.have.been.called
      })

      it('skips a subscription whose plan was removed from the settings', async () => {
        repository.findDueForRenewal.onFirstCall().resolves([subscription({ planId: 'retired' })])

        expect(await service.processLifecycle(NOW)).to.equal(0)

        expect(paymentsService.createInvoice).not.to.have.been.called
        expect(repository.upsert).not.to.have.been.called
      })
    })

    describe('ended periods', () => {
      it('moves a lapsed subscription into grace counted from the period end', async () => {
        const periodEnd = at(-DAY)
        repository.findPeriodEnded.onFirstCall().resolves([subscription({ currentPeriodEnd: periodEnd })])

        expect(await service.processLifecycle(NOW)).to.equal(1)

        expect(repository.upsert.firstCall.args[0]).to.include({
          status: SubscriptionStatus.PAST_DUE,
        })
        expect(repository.upsert.firstCall.args[0].graceEndsAt).to.deep.equal(new Date(periodEnd.getTime() + 3 * DAY))
      })

      it('also ends a period whose renewal invoice was never paid', async () => {
        repository.findPeriodEnded
          .onFirstCall()
          .resolves([subscription({ status: SubscriptionStatus.RENEWAL_PENDING, currentPeriodEnd: at(-DAY) })])

        await service.processLifecycle(NOW)

        expect(repository.upsert.firstCall.args[0].status).to.equal(SubscriptionStatus.PAST_DUE)
      })

      it('expires a cancelled subscription without grace', async () => {
        repository.findPeriodEnded
          .onFirstCall()
          .resolves([subscription({ currentPeriodEnd: at(-DAY), cancelAtPeriodEnd: true })])

        await service.processLifecycle(NOW)

        expect(repository.upsert.firstCall.args[0]).to.include({
          status: SubscriptionStatus.EXPIRED,
          graceEndsAt: null,
        })
      })

      it('leaves a subscription whose plan was removed from the settings alone', async () => {
        repository.findPeriodEnded.onFirstCall().resolves([subscription({ planId: 'retired' })])

        expect(await service.processLifecycle(NOW)).to.equal(0)
        expect(repository.upsert).not.to.have.been.called
      })
    })

    describe('grace expiry', () => {
      it('expires a subscription whose grace period is over', async () => {
        repository.findGraceEnded
          .onFirstCall()
          .resolves([
            subscription({
              status: SubscriptionStatus.PAST_DUE,
              currentPeriodEnd: at(-5 * DAY),
              graceEndsAt: at(-DAY),
            }),
          ])

        expect(await service.processLifecycle(NOW)).to.equal(1)

        expect(repository.upsert.firstCall.args[0]).to.include({
          status: SubscriptionStatus.EXPIRED,
          graceEndsAt: null,
        })
      })

      it('expires even when the plan was removed, since the grace end is already recorded', async () => {
        repository.findGraceEnded
          .onFirstCall()
          .resolves([subscription({ planId: 'retired', status: SubscriptionStatus.PAST_DUE, graceEndsAt: at(-DAY) })])

        expect(await service.processLifecycle(NOW)).to.equal(1)
      })
    })

    describe('paging', () => {
      const page = (count: number) => Array.from({ length: count }, () => subscription({ currentPeriodEnd: at(-DAY) }))

      it('asks again while pages come back full, then stops on a short one', async () => {
        repository.findPeriodEnded.onCall(0).resolves(page(10))
        repository.findPeriodEnded.onCall(1).resolves(page(3))

        expect(await service.processLifecycle(NOW)).to.equal(13)

        expect(repository.findPeriodEnded).to.have.been.calledTwice
      })

      it('stops when a full page makes no progress, so a stuck row cannot loop the pass', async () => {
        repository.findPeriodEnded.resolves(page(10).map((s) => ({ ...s, planId: 'retired' })))

        expect(await service.processLifecycle(NOW)).to.equal(0)

        expect(repository.findPeriodEnded).to.have.been.calledOnce
      })

      it('keeps going after one subscription fails', async () => {
        repository.findPeriodEnded.onFirstCall().resolves([subscription(), subscription({ pubkey: 'b'.repeat(64) })])
        repository.upsert.onFirstCall().rejects(new Error('db error'))

        expect(await service.processLifecycle(NOW)).to.equal(1)

        expect(repository.upsert).to.have.been.calledTwice
      })

      it('caps the work of one pass', async () => {
        repository.findPeriodEnded.resolves(page(10))

        expect(await service.processLifecycle(NOW)).to.equal(100)

        expect(repository.findPeriodEnded).to.have.callCount(10)
      })
    })

    it('ends periods before sending renewals, so a lapsed subscription is not also sent an invoice', async () => {
      const calls: string[] = []
      repository.findPeriodEnded.callsFake(async () => {
        calls.push('ended')
        return []
      })
      repository.findGraceEnded.callsFake(async () => {
        calls.push('grace')
        return []
      })
      repository.findDueForRenewal.callsFake(async () => {
        calls.push('renewal')
        return []
      })

      await service.processLifecycle(NOW)

      expect(calls).to.deep.equal(['ended', 'grace', 'renewal'])
    })
  })

  describe('cancel', () => {
    it('stops renewal and keeps the status, since access lasts to the period end', async () => {
      repository.findByPubkey.resolves(subscription())

      expect(await service.cancel(PUBKEY)).to.equal(true)

      expect(repository.upsert.firstCall.args[0]).to.include({
        status: SubscriptionStatus.ACTIVE,
        cancelAtPeriodEnd: true,
      })
    })

    it('returns false when the user has no subscription', async () => {
      expect(await service.cancel(PUBKEY)).to.equal(false)
      expect(repository.upsert).not.to.have.been.called
    })

    it('returns false for an expired subscription', async () => {
      repository.findByPubkey.resolves(subscription({ status: SubscriptionStatus.EXPIRED }))

      expect(await service.cancel(PUBKEY)).to.equal(false)
    })

    it('returns false for a subscription that never ends, since there is nothing to stop', async () => {
      repository.findByPubkey.resolves(subscription({ planId: 'grandfathered', currentPeriodEnd: null }))

      expect(await service.cancel(PUBKEY)).to.equal(false)
    })
  })
})
