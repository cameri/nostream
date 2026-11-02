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
  graceEndsAt: at(5 * DAY),
  cancelAtPeriodEnd: false,
  createdAt: at(-28 * DAY),
  updatedAt: at(-28 * DAY),
  ...overrides,
})

describe('SubscriptionService', () => {
  let sandbox: Sinon.SinonSandbox
  let repository: Record<string, Sinon.SinonStub>
  let paymentsService: { createInvoice: Sinon.SinonStub; sendRenewalNotification: Sinon.SinonStub }
  let currentSettings: Settings
  let service: SubscriptionService

  beforeEach(() => {
    sandbox = Sinon.createSandbox()
    repository = {
      findByPubkey: sandbox.stub().resolves(undefined),
      upsert: sandbox.stub().resolves(1),
      updateIfCurrent: sandbox.stub().resolves(true),
      findDueForRenewal: sandbox.stub().resolves([]),
      findPeriodEnded: sandbox.stub().resolves([]),
      findGraceEnded: sandbox.stub().resolves([]),
    }
    paymentsService = {
      createInvoice: sandbox.stub().resolves({ id: 'invoice-id', bolt11: 'lnbc1...' }),
      sendRenewalNotification: sandbox.stub().resolves(),
    }
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

      it('issues an invoice for the plan price, tells the subscriber and waits for payment', async () => {
        const due = subscription()
        repository.findDueForRenewal.onFirstCall().resolves([due])

        expect(await service.processLifecycle(NOW)).to.equal(1)

        expect(paymentsService.createInvoice).to.have.been.calledOnce
        const [pubkey, amount, description, planId] = paymentsService.createInvoice.firstCall.args
        expect(pubkey).to.equal(PUBKEY)
        expect(amount).to.equal(1_000_000n)
        expect(description).to.contain('test relay').and.contain('basic')
        expect(planId).to.equal('basic')
        expect(paymentsService.sendRenewalNotification).to.have.been.calledOnceWithExactly({
          id: 'invoice-id',
          bolt11: 'lnbc1...',
        })
        expect(repository.updateIfCurrent).to.have.been.calledOnceWithExactly(due, {
          status: SubscriptionStatus.RENEWAL_PENDING,
        })
      })

      it('replaces an expired renewal invoice without touching the status, which is already renewal pending', async () => {
        repository.findDueForRenewal
          .onFirstCall()
          .resolves([subscription({ status: SubscriptionStatus.RENEWAL_PENDING })])

        expect(await service.processLifecycle(NOW)).to.equal(1)

        expect(paymentsService.createInvoice).to.have.been.calledOnce
        expect(paymentsService.sendRenewalNotification).to.have.been.calledOnce
        expect(repository.updateIfCurrent).not.to.have.been.called
      })

      it('does not change the status when the invoice cannot be created, so the next pass retries', async () => {
        repository.findDueForRenewal.onFirstCall().resolves([subscription()])
        paymentsService.createInvoice.rejects(new Error('processor down'))

        expect(await service.processLifecycle(NOW)).to.equal(0)

        expect(paymentsService.sendRenewalNotification).not.to.have.been.called
        expect(repository.updateIfCurrent).not.to.have.been.called
      })

      it('does not count a renewal whose subscription was paid in the meantime', async () => {
        repository.findDueForRenewal.onFirstCall().resolves([subscription()])
        repository.updateIfCurrent.resolves(false)

        expect(await service.processLifecycle(NOW)).to.equal(0)
      })

      it('skips a subscription whose plan was removed from the settings', async () => {
        repository.findDueForRenewal.onFirstCall().resolves([subscription({ planId: 'retired' })])

        expect(await service.processLifecycle(NOW)).to.equal(0)

        expect(paymentsService.createInvoice).not.to.have.been.called
        expect(repository.updateIfCurrent).not.to.have.been.called
      })
    })

    describe('ended periods', () => {
      it('moves a lapsed subscription into grace counted from the period end', async () => {
        const periodEnd = at(-DAY)
        const lapsed = subscription({ currentPeriodEnd: periodEnd })
        repository.findPeriodEnded.onFirstCall().resolves([lapsed])

        expect(await service.processLifecycle(NOW)).to.equal(1)

        expect(repository.updateIfCurrent).to.have.been.calledOnce
        const [expected, changes] = repository.updateIfCurrent.firstCall.args
        expect(expected).to.equal(lapsed)
        expect(changes.status).to.equal(SubscriptionStatus.PAST_DUE)
        expect(changes.graceEndsAt).to.deep.equal(new Date(periodEnd.getTime() + 3 * DAY))
      })

      it('also ends a period whose renewal invoice was never paid', async () => {
        repository.findPeriodEnded
          .onFirstCall()
          .resolves([subscription({ status: SubscriptionStatus.RENEWAL_PENDING, currentPeriodEnd: at(-DAY) })])

        await service.processLifecycle(NOW)

        expect(repository.updateIfCurrent.firstCall.args[1].status).to.equal(SubscriptionStatus.PAST_DUE)
      })

      it('expires a lapsed subscription straight away when the plan has no grace', async () => {
        currentSettings.payments.subscriptionPlans[0].graceSeconds = 0
        repository.findPeriodEnded.onFirstCall().resolves([subscription({ currentPeriodEnd: at(-DAY) })])

        await service.processLifecycle(NOW)

        expect(repository.updateIfCurrent.firstCall.args[1]).to.deep.equal({
          status: SubscriptionStatus.EXPIRED,
          graceEndsAt: null,
        })
      })

      it('leaves a subscription whose plan was removed from the settings alone', async () => {
        repository.findPeriodEnded.onFirstCall().resolves([subscription({ planId: 'retired' })])

        expect(await service.processLifecycle(NOW)).to.equal(0)
        expect(repository.updateIfCurrent).not.to.have.been.called
      })

      it('does not overwrite a subscription that was paid after it was read', async () => {
        repository.findPeriodEnded.onFirstCall().resolves([subscription({ currentPeriodEnd: at(-DAY) })])
        repository.updateIfCurrent.resolves(false)

        expect(await service.processLifecycle(NOW)).to.equal(0)
      })
    })

    describe('grace expiry', () => {
      it('expires a subscription whose grace period is over', async () => {
        const pastDue = subscription({
          status: SubscriptionStatus.PAST_DUE,
          currentPeriodEnd: at(-5 * DAY),
          graceEndsAt: at(-DAY),
        })
        repository.findGraceEnded.onFirstCall().resolves([pastDue])

        expect(await service.processLifecycle(NOW)).to.equal(1)

        expect(repository.updateIfCurrent).to.have.been.calledOnceWithExactly(pastDue, {
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

      it('does not expire a subscription that was paid after it was read', async () => {
        repository.findGraceEnded.onFirstCall().resolves([subscription({ status: SubscriptionStatus.PAST_DUE })])
        repository.updateIfCurrent.resolves(false)

        expect(await service.processLifecycle(NOW)).to.equal(0)
      })
    })

    describe('paging', () => {
      const page = (count: number, overrides: Partial<UserSubscription> = {}) =>
        Array.from({ length: count }, () => subscription({ currentPeriodEnd: at(-DAY), ...overrides }))

      it('asks again while pages come back full, then stops on a short one', async () => {
        repository.findPeriodEnded.onCall(0).resolves(page(10))
        repository.findPeriodEnded.onCall(1).resolves(page(3))

        expect(await service.processLifecycle(NOW)).to.equal(13)

        expect(repository.findPeriodEnded).to.have.been.calledTwice
      })

      it('moves past rows it cannot handle, so they do not block the ones behind them', async () => {
        const stuck = page(10, { planId: 'retired' })
        const fine = page(3)
        repository.findPeriodEnded.onCall(0).resolves(stuck)
        repository.findPeriodEnded.onCall(1).resolves(fine)

        expect(await service.processLifecycle(NOW)).to.equal(3)

        expect(repository.findPeriodEnded.firstCall.args.slice(1)).to.deep.equal([10, 0])
        expect(repository.findPeriodEnded.secondCall.args.slice(1)).to.deep.equal([10, 10])
      })

      it('carries on behind the rows it skipped in the next pass, so more stuck rows than one pass reads do not hide the rest', async () => {
        repository.findPeriodEnded.resolves(page(10, { planId: 'retired' }))

        await service.processLifecycle(NOW)

        // The first pass read ten pages of stuck rows and gave up at the cap; the next starts behind them.
        expect(repository.findPeriodEnded.firstCall.args.slice(1)).to.deep.equal([10, 0])
        repository.findPeriodEnded.resetHistory()
        repository.findPeriodEnded.resolves([])

        await service.processLifecycle(NOW)

        expect(repository.findPeriodEnded.firstCall.args.slice(1)).to.deep.equal([10, 100])
      })

      it('starts over from the front once a pass reaches the end of the rows', async () => {
        repository.findPeriodEnded.onCall(0).resolves(page(10, { planId: 'retired' }))
        repository.findPeriodEnded.onCall(1).resolves([])
        await service.processLifecycle(NOW)
        repository.findPeriodEnded.resetHistory()
        repository.findPeriodEnded.resolves([])

        await service.processLifecycle(NOW)

        expect(repository.findPeriodEnded.firstCall.args.slice(1)).to.deep.equal([10, 0])
      })

      it('counts only the rows left behind when handled ones drop out of the next query', async () => {
        const mixed = [...page(7), ...page(3, { planId: 'retired' })]
        repository.findPeriodEnded.onCall(0).resolves(mixed)
        repository.findPeriodEnded.onCall(1).resolves([])

        await service.processLifecycle(NOW)

        expect(repository.findPeriodEnded.secondCall.args.slice(1)).to.deep.equal([10, 3])
      })

      it('keeps going after one subscription fails', async () => {
        repository.findPeriodEnded.onFirstCall().resolves([subscription(), subscription({ pubkey: 'b'.repeat(64) })])
        repository.updateIfCurrent.onFirstCall().rejects(new Error('db error'))

        expect(await service.processLifecycle(NOW)).to.equal(1)

        expect(repository.updateIfCurrent).to.have.been.calledTwice
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
})
