import chai from 'chai'
import chaiAsPromised from 'chai-as-promised'
import Sinon from 'sinon'
import sinonChai from 'sinon-chai'

chai.use(sinonChai)
chai.use(chaiAsPromised)

import * as eventUtils from '../../../src/utils/event'
import { Invoice, InvoicePurpose, InvoiceStatus, InvoiceUnit } from '../../../src/@types/invoice'
import { OperatorNotificationEventType } from '../../../src/@types/operator-notifications'
import { PENDING_INVOICE_PAGE_SIZE, PaymentsService } from '../../../src/services/payments-service'

const { expect } = chai

describe('PaymentsService', () => {
  let sandbox: Sinon.SinonSandbox
  let service: PaymentsService
  let mockTrx: { commit: Sinon.SinonStub; rollback: Sinon.SinonStub }
  let dbClient: any
  let paymentsProcessor: any
  let userRepository: any
  let invoiceRepository: any
  let eventRepository: any
  let notificationOutboxRepository: any
  let settings: Sinon.SinonStub

  const stubInvoice = (overrides: Partial<Invoice> = {}): Invoice => ({
    id: 'invoice-id',
    pubkey: 'pubkey1234',
    bolt11: 'lnbc500n1...',
    amountRequested: 1000n,
    unit: InvoiceUnit.SATS,
    status: InvoiceStatus.PENDING,
    description: 'test invoice',
    confirmedAt: null,
    expiresAt: new Date('2099-01-01'),
    updatedAt: new Date(),
    createdAt: new Date(),
    ...overrides,
  })

  beforeEach(() => {
    sandbox = Sinon.createSandbox()

    mockTrx = {
      commit: sandbox.stub().resolves([]),
      rollback: sandbox.stub().resolves([]),
    }

    // Simulate Knex's client.transaction(null, opts) → returns a trx object
    dbClient = { transaction: sandbox.stub().resolves(mockTrx) }

    paymentsProcessor = {
      createInvoice: sandbox.stub(),
      getInvoice: sandbox.stub(),
    }

    userRepository = {
      upsert: sandbox.stub().resolves(),
      admitUser: sandbox.stub().resolves(),
      findByPubkey: sandbox.stub(),
    }

    invoiceRepository = {
      findById: sandbox.stub().resolves(undefined),
      findPendingInvoices: sandbox.stub(),
      findUnconfirmedPeeringInvoices: sandbox.stub().resolves([]),
      upsert: sandbox.stub().resolves(),
      updateStatus: sandbox.stub(),
      confirmInvoice: sandbox.stub().resolves(),
      updatePeriod: sandbox.stub().resolves(),
    }

    eventRepository = {
      create: sandbox.stub().resolves(),
    }

    notificationOutboxRepository = {
      enqueue: sandbox.stub().resolves(),
    }

    settings = sandbox.stub()

    // Stub module-level utilities used inside PaymentsService
    sandbox.stub(eventUtils, 'getRelayPrivateKey').returns('fakeprivkey')
    sandbox.stub(eventUtils, 'getPublicKey').returns('fakepubkey')
    sandbox.stub(eventUtils, 'identifyEvent').resolves({
      id: 'eventid',
      pubkey: 'fakepubkey',
      kind: 402,
      created_at: 1000,
      content: '',
      tags: [],
    } as any)
    sandbox.stub(eventUtils, 'signEvent').returns(
      async () => ({
        id: 'eventid',
        pubkey: 'fakepubkey',
        kind: 402,
        created_at: 1000,
        content: '',
        tags: [],
        sig: 'fakesig',
      } as any)
    )
    sandbox.stub(eventUtils, 'broadcastEvent').resolves()

    service = new PaymentsService(
      dbClient,
      paymentsProcessor,
      userRepository,
      invoiceRepository,
      eventRepository,
      settings,
      notificationOutboxRepository,
    )
  })

  afterEach(() => {
    sandbox.restore()
  })


  describe('getPendingInvoices', () => {
    it('returns invoices from the repository with offset 0 and limit 10', async () => {
      const invoices = [stubInvoice()]
      invoiceRepository.findPendingInvoices.resolves(invoices)

      const result = await service.getPendingInvoices()

      expect(result).to.deep.equal(invoices)
      expect(invoiceRepository.findPendingInvoices).to.have.been.calledOnceWithExactly(0, 10)
    })

    it('re-throws repository errors', async () => {
      invoiceRepository.findPendingInvoices.rejects(new Error('db error'))

      await expect(service.getPendingInvoices()).to.be.rejectedWith('db error')
    })
  })


  describe('getUnconfirmedPeeringInvoices', () => {
    it('returns completed peering invoices that never settled', async () => {
      const invoices = [stubInvoice({ confirmedAt: null })]
      invoiceRepository.findUnconfirmedPeeringInvoices.resolves(invoices)

      const result = await service.getUnconfirmedPeeringInvoices()

      expect(result).to.deep.equal(invoices)
      expect(invoiceRepository.findUnconfirmedPeeringInvoices).to.have.been.calledOnceWithExactly(
        PENDING_INVOICE_PAGE_SIZE,
      )
    })

    it('re-throws repository errors', async () => {
      invoiceRepository.findUnconfirmedPeeringInvoices.rejects(new Error('db error'))

      await expect(service.getUnconfirmedPeeringInvoices()).to.be.rejectedWith('db error')
    })
  })

  describe('getInvoiceFromPaymentsProcessor', () => {
    it('passes a string invoice ID directly to the payments processor', async () => {
      const partial = { id: 'inv', status: InvoiceStatus.PENDING }
      paymentsProcessor.getInvoice.resolves(partial)

      const result = await service.getInvoiceFromPaymentsProcessor('string-invoice-id')

      expect(paymentsProcessor.getInvoice).to.have.been.calledOnceWithExactly('string-invoice-id')
      expect(result).to.deep.equal(partial)
    })

    it('passes the full invoice object when it has a verifyURL', async () => {
      const invoice = stubInvoice({ verifyURL: 'https://verify.example.com/inv' })
      paymentsProcessor.getInvoice.resolves({})

      await service.getInvoiceFromPaymentsProcessor(invoice)

      expect(paymentsProcessor.getInvoice).to.have.been.calledOnceWithExactly(invoice)
    })

    it('passes invoice.id when the invoice has no verifyURL', async () => {
      const invoice = stubInvoice({ id: 'target-id', verifyURL: undefined })
      paymentsProcessor.getInvoice.resolves({})

      await service.getInvoiceFromPaymentsProcessor(invoice)

      expect(paymentsProcessor.getInvoice).to.have.been.calledOnceWithExactly('target-id')
    })

    it('re-throws payments processor errors', async () => {
      paymentsProcessor.getInvoice.rejects(new Error('processor error'))

      await expect(
        service.getInvoiceFromPaymentsProcessor('any-id')
      ).to.be.rejectedWith('processor error')
    })
  })


  describe('createInvoice', () => {
    const invoiceResponse = {
      id: 'new-inv-id',
      bolt11: 'lnbc...',
      amountRequested: 1000n,
      description: 'test',
      unit: InvoiceUnit.SATS,
      status: InvoiceStatus.PENDING,
      expiresAt: new Date('2099-01-01'),
      createdAt: new Date(),
      verifyURL: undefined,
    }

    beforeEach(() => {
      paymentsProcessor.createInvoice.resolves(invoiceResponse)
    })

    it('upserts user, creates invoice via processor, persists, and returns the invoice', async () => {
      settings.returns({ payments: { invoiceExpirySeconds: 3600 } })

      const result = await service.createInvoice('pubkey1234', 1000n, 'test')

      expect(dbClient.transaction).to.have.been.called
      expect(userRepository.upsert).to.have.been.calledOnce
      expect(paymentsProcessor.createInvoice).to.have.been.calledOnceWithExactly({
        amount: 1000n,
        description: 'test',
        requestId: 'pubkey1234',
      })
      expect(invoiceRepository.upsert).to.have.been.calledOnce
      expect(mockTrx.commit).to.have.been.calledOnce
      expect(result.id).to.equal('new-inv-id')
      expect(result.pubkey).to.equal('pubkey1234')
    })

    it('stores the plan on the invoice and returns it', async () => {
      settings.returns({ payments: { invoiceExpirySeconds: 3600 } })

      const result = await service.createInvoice('pubkey1234', 1000n, 'test', 'basic')

      expect(invoiceRepository.upsert.firstCall.args[0]).to.include({ planId: 'basic' })
      expect(result.planId).to.equal('basic')
    })

    it('gives the invoice an expiry when the processor does not report one', async () => {
      // Without this the row can never be retired and stays pending forever.
      settings.returns({ payments: { invoiceExpirySeconds: 3600 } })

      const result = await service.createInvoice('pubkey1234', 1000n, 'test')

      expect(result.expiresAt).to.be.instanceOf(Date)
      const [persisted] = invoiceRepository.upsert.firstCall.args
      expect(persisted.expiresAt).to.deep.equal(result.expiresAt)
    })

    it('keeps the expiry the processor reported', async () => {
      const processorExpiry = new Date('2030-06-01T00:00:00.000Z')
      settings.returns({ payments: { invoiceExpirySeconds: 3600 } })
      paymentsProcessor.createInvoice.resolves({
        id: 'new-inv-id',
        bolt11: 'lnbc',
        amountRequested: 1000n,
        description: 'test',
        unit: InvoiceUnit.MSATS,
        status: InvoiceStatus.PENDING,
        expiresAt: processorExpiry,
        createdAt: new Date(),
      })

      const result = await service.createInvoice('pubkey1234', 1000n, 'test')

      expect(result.expiresAt).to.equal(processorExpiry)
    })

    it('still creates the invoice when settings are unavailable', async () => {
      settings.returns(undefined)

      const result = await service.createInvoice('pubkey1234', 1000n, 'test')

      expect(result.expiresAt).to.be.instanceOf(Date)
    })

    it('rolls back the transaction and re-throws when the processor fails', async () => {
      paymentsProcessor.createInvoice.rejects(new Error('processor fail'))

      await expect(
        service.createInvoice('pubkey1234', 1000n, 'test')
      ).to.be.rejectedWith('processor fail')

      expect(mockTrx.rollback).to.have.been.calledOnce
      expect(mockTrx.commit).not.to.have.been.called
    })
  })


  describe('updateInvoice', () => {
    it('delegates to invoiceRepository.updateStatus with id and status', async () => {
      invoiceRepository.updateStatus.resolves()

      await service.updateInvoice({ id: 'inv-id', status: InvoiceStatus.COMPLETED })

      expect(invoiceRepository.updateStatus).to.have.been.calledOnceWithExactly({
        id: 'inv-id',
        status: InvoiceStatus.COMPLETED,
      })
    })

    it('re-throws repository errors', async () => {
      invoiceRepository.updateStatus.rejects(new Error('update error'))

      await expect(
        service.updateInvoice({ id: 'inv-id', status: InvoiceStatus.PENDING })
      ).to.be.rejectedWith('update error')
    })
  })


  describe('updateInvoiceStatus', () => {
    it('returns the updated invoice from the repository', async () => {
      const updated = stubInvoice({ status: InvoiceStatus.COMPLETED })
      invoiceRepository.updateStatus.resolves(updated)

      const result = await service.updateInvoiceStatus({ id: 'inv-id', status: InvoiceStatus.COMPLETED })

      expect(result).to.deep.equal(updated)
      expect(invoiceRepository.updateStatus).to.have.been.calledOnceWithExactly({
        id: 'inv-id',
        status: InvoiceStatus.COMPLETED,
      })
    })

    it('re-throws repository errors', async () => {
      invoiceRepository.updateStatus.rejects(new Error('update error'))

      await expect(
        service.updateInvoiceStatus({ id: 'inv-id', status: InvoiceStatus.PENDING })
      ).to.be.rejectedWith('update error')
    })
  })


  describe('confirmInvoice', () => {
    const makeCompletedInvoice = (overrides: Partial<Invoice> = {}): Invoice =>
      stubInvoice({
        status: InvoiceStatus.COMPLETED,
        confirmedAt: new Date(),
        amountPaid: 2000n,
        unit: InvoiceUnit.MSATS,
        ...overrides,
      })

    const makeSettings = (admissionFeeSchedules: any[] = []) => ({
      payments: {
        feeSchedules: { admission: admissionFeeSchedules },
      },
    })

    beforeEach(() => {
      settings.returns(makeSettings())
    })

    it('throws when confirmedAt is not set', async () => {
      // Validation fires before transaction.begin(); rollback() on an unstarted
      // transaction throws its own error, which is what ultimately propagates.
      await expect(
        service.confirmInvoice(makeCompletedInvoice({ confirmedAt: null }))
      ).to.be.rejectedWith('Unable to get transaction: transaction not started.')
    })

    it('throws when status is not COMPLETED', async () => {
      await expect(
        service.confirmInvoice(makeCompletedInvoice({ status: InvoiceStatus.PENDING }))
      ).to.be.rejectedWith('Unable to get transaction: transaction not started.')
    })

    it('throws when amountPaid is not a bigint', async () => {
      await expect(
        service.confirmInvoice(makeCompletedInvoice({ amountPaid: undefined }))
      ).to.be.rejectedWith('Unable to get transaction: transaction not started.')
    })

    it('enqueues operator invoice paid in the confirmation transaction', async () => {
      const invoice = makeCompletedInvoice()

      await service.confirmInvoice(invoice)

      expect(notificationOutboxRepository.enqueue).to.have.been.calledOnceWithExactly(
        OperatorNotificationEventType.ADMISSION_INVOICE_PAID,
        {
          invoiceId: invoice.id,
          pubkey: invoice.pubkey,
          amountPaid: invoice.amountPaid!.toString(),
          unit: invoice.unit,
          confirmedAt: invoice.confirmedAt!.toISOString(),
        },
        mockTrx,
      )
    })

    it('converts SATS to msats before comparing against the fee', async () => {
      // 2 sats = 2000 msats; fee = 1000 msats → should admit
      settings.returns(makeSettings([{ enabled: true, amount: 1000n }]))

      await service.confirmInvoice(makeCompletedInvoice({
        unit: InvoiceUnit.SATS,
        amountPaid: 2n,
      }))

      expect(userRepository.admitUser).to.have.been.calledOnce
      expect(mockTrx.commit).to.have.been.calledOnce
    })

    it('converts BTC to msats before comparing against the fee', async () => {
      // 1 btc = 100_000_000 sats = 100_000_000_000 msats; fee = 1000 msats → should admit
      settings.returns(makeSettings([{ enabled: true, amount: 1000n }]))

      await service.confirmInvoice(makeCompletedInvoice({
        unit: InvoiceUnit.BTC,
        amountPaid: 1n,
      }))

      expect(userRepository.admitUser).to.have.been.calledOnce
    })

    it('does not convert MSATS (uses amount directly)', async () => {
      settings.returns(makeSettings([{ enabled: true, amount: 1000n }]))

      await service.confirmInvoice(makeCompletedInvoice({
        unit: InvoiceUnit.MSATS,
        amountPaid: 2000n,
      }))

      expect(userRepository.admitUser).to.have.been.calledOnce
    })

    it('admits the user when the paid amount meets the admission fee', async () => {
      settings.returns(makeSettings([{ enabled: true, amount: 1000n }]))

      await service.confirmInvoice(makeCompletedInvoice({
        pubkey: 'admittedpubkey',
        unit: InvoiceUnit.MSATS,
        amountPaid: 5000n,
      }))

      expect(userRepository.admitUser).to.have.been.calledOnce
      const [pubkeyArg, admittedAtArg] = userRepository.admitUser.firstCall.args
      expect(pubkeyArg).to.equal('admittedpubkey')
      expect(admittedAtArg).to.be.instanceOf(Date)
      expect(mockTrx.commit).to.have.been.calledOnce
    })

    it('does not admit the user when the paid amount is below the admission fee', async () => {
      settings.returns(makeSettings([{ enabled: true, amount: 10000n }]))

      await service.confirmInvoice(makeCompletedInvoice({
        unit: InvoiceUnit.MSATS,
        amountPaid: 500n,
      }))

      expect(userRepository.admitUser).not.to.have.been.called
      expect(mockTrx.commit).to.have.been.calledOnce
    })

    it('does not admit the user when there are no admission fee schedules', async () => {
      settings.returns(makeSettings([]))

      await service.confirmInvoice(makeCompletedInvoice())

      expect(userRepository.admitUser).not.to.have.been.called
    })

    it('falls back to an empty admission array when feeSchedules is missing', async () => {
      // Covers the `?? []` branch on `payments?.feeSchedules?.admission`
      settings.returns({ payments: {} })

      await service.confirmInvoice(makeCompletedInvoice())

      expect(userRepository.admitUser).not.to.have.been.called
    })

    it('ignores disabled fee schedules when computing the admission amount', async () => {
      settings.returns(makeSettings([{ enabled: false, amount: 1000n }]))

      await service.confirmInvoice(makeCompletedInvoice({
        unit: InvoiceUnit.MSATS,
        amountPaid: 5000n,
      }))

      // disabled → admissionFeeAmount = 0 → condition false → user not admitted
      expect(userRepository.admitUser).not.to.have.been.called
    })

    it('skips the fee for whitelisted pubkeys (exact match)', async () => {
      settings.returns(makeSettings([
        { enabled: true, amount: 1000n, whitelists: { pubkeys: ['whitelistedpubkey'] } },
      ]))

      await service.confirmInvoice(makeCompletedInvoice({
        pubkey: 'whitelistedpubkey',
        unit: InvoiceUnit.MSATS,
        amountPaid: 5000n,
      }))

      // pubkey does not exactly match whitelist entry -> fee applies -> user must pay to get admitted
      expect(userRepository.admitUser).not.to.have.been.called
    })

    it('applies the fee when pubkey is not an exact whitelist match (prefix alone is insufficient)', async () => {
      settings.returns(makeSettings([
        { enabled: true, amount: 1000n, whitelists: { pubkeys: ['whitelisted'] } },
      ]))
      await service.confirmInvoice(makeCompletedInvoice({
        pubkey: 'whitelistedpubkey',
        unit: InvoiceUnit.MSATS,
        amountPaid: 5000n,
      }))
      expect(userRepository.admitUser).to.have.been.calledOnce
    })


    describe('subscription plans', () => {
      const DAY = 86_400_000
      const plan = { id: 'basic', amount: 5_000_000n, intervalSeconds: 2_592_000, graceSeconds: 259_200 }
      let userSubscriptionRepository: any

      const plansSettings = (plans: any[] = [plan], admission: any[] = [{ enabled: true, amount: 1000n }]) => ({
        payments: { enabled: true, feeSchedules: { admission }, subscriptionPlans: plans },
      })

      beforeEach(() => {
        userSubscriptionRepository = {
          findByPubkey: sandbox.stub().resolves(undefined),
          upsert: sandbox.stub().resolves(1),
        }
        invoiceRepository.findById = sandbox.stub().resolves(stubInvoice({ planId: 'basic' }))
        settings.returns(plansSettings())
        service = new PaymentsService(
          dbClient,
          paymentsProcessor,
          userRepository,
          invoiceRepository,
          eventRepository,
          settings,
          notificationOutboxRepository,
          userSubscriptionRepository,
        )
      })

      it('starts a subscription for the plan on the stored invoice and admits the user', async () => {
        await service.confirmInvoice(makeCompletedInvoice({ amountPaid: 5_000_000n }))

        expect(invoiceRepository.findById).to.have.been.calledOnceWithExactly('invoice-id', mockTrx)
        expect(userSubscriptionRepository.upsert).to.have.been.calledOnce
        const [subscription, client] = userSubscriptionRepository.upsert.firstCall.args
        expect(subscription).to.include({ pubkey: 'pubkey1234', planId: 'basic', status: 'active' })
        expect(subscription.currentPeriodEnd.getTime() - subscription.currentPeriodStart.getTime()).to.equal(
          30 * DAY,
        )
        expect(client).to.equal(mockTrx)
        expect(userRepository.admitUser).to.have.been.calledOnce
        expect(mockTrx.commit).to.have.been.calledOnce
      })

      it('prefers the plan on the invoice it was given over the stored one', async () => {
        invoiceRepository.findById.resolves(stubInvoice({ planId: null }))

        await service.confirmInvoice(makeCompletedInvoice({ amountPaid: 5_000_000n, planId: 'basic' }))

        expect(userSubscriptionRepository.upsert).to.have.been.calledOnce
      })

      it('extends a running subscription from its period end', async () => {
        const periodEnd = new Date(Date.now() + 5 * DAY)
        userSubscriptionRepository.findByPubkey.resolves({
          pubkey: 'pubkey1234',
          planId: 'basic',
          status: 'active',
          currentPeriodStart: new Date(Date.now() - 25 * DAY),
          currentPeriodEnd: periodEnd,
          graceEndsAt: null,
          cancelAtPeriodEnd: false,
        })

        await service.confirmInvoice(makeCompletedInvoice({ amountPaid: 5_000_000n }))

        const [subscription] = userSubscriptionRepository.upsert.firstCall.args
        expect(subscription.currentPeriodStart).to.deep.equal(periodEnd)
        expect(subscription.currentPeriodEnd).to.deep.equal(new Date(periodEnd.getTime() + 30 * DAY))
      })

      it('does not extend the subscription again for a repeated callback of an invoice that was already confirmed', async () => {
        invoiceRepository.findById.resolves(stubInvoice({ planId: 'basic', confirmedAt: new Date() }))

        await service.confirmInvoice(makeCompletedInvoice({ amountPaid: 5_000_000n }))

        expect(userSubscriptionRepository.findByPubkey).not.to.have.been.called
        expect(userSubscriptionRepository.upsert).not.to.have.been.called
        expect(mockTrx.commit).to.have.been.calledOnce
      })

      it('reads the stored invoice before confirming it, so a first confirmation is told from a repeat', async () => {
        await service.confirmInvoice(makeCompletedInvoice({ amountPaid: 5_000_000n }))

        expect(invoiceRepository.findById).to.have.been.calledBefore(invoiceRepository.confirmInvoice)
      })

      it('takes the unit from the stored invoice when the callback does not report one', async () => {
        // OpenNode reports the amount in sats without a unit.
        invoiceRepository.findById.resolves(stubInvoice({ planId: 'basic', unit: InvoiceUnit.SATS }))

        await service.confirmInvoice(makeCompletedInvoice({ unit: undefined, amountPaid: 5_000n } as any))

        expect(userSubscriptionRepository.upsert).to.have.been.calledOnce
      })

      it('still rejects an underpayment when the unit comes from the stored invoice', async () => {
        invoiceRepository.findById.resolves(stubInvoice({ planId: 'basic', unit: InvoiceUnit.SATS }))

        await service.confirmInvoice(makeCompletedInvoice({ unit: undefined, amountPaid: 4_999n } as any))

        expect(userSubscriptionRepository.upsert).not.to.have.been.called
      })

      it('converts SATS to msats before comparing against the plan price', async () => {
        await service.confirmInvoice(makeCompletedInvoice({ unit: InvoiceUnit.SATS, amountPaid: 5_000n }))

        expect(userSubscriptionRepository.upsert).to.have.been.calledOnce
      })

      it('does not start a subscription when the paid amount is below the plan price', async () => {
        await service.confirmInvoice(makeCompletedInvoice({ amountPaid: 4_999_999n }))

        expect(userSubscriptionRepository.upsert).not.to.have.been.called
        expect(userRepository.admitUser).not.to.have.been.called
        expect(mockTrx.commit).to.have.been.calledOnce
      })

      it('does not fall back to the admission fee when a plan invoice is underpaid', async () => {
        settings.returns(plansSettings([plan], [{ enabled: true, amount: 1000n }]))

        await service.confirmInvoice(makeCompletedInvoice({ amountPaid: 4_000_000n }))

        expect(userRepository.admitUser).not.to.have.been.called
      })

      it('treats an invoice without a plan as an admission payment', async () => {
        invoiceRepository.findById.resolves(stubInvoice({ planId: null }))

        await service.confirmInvoice(makeCompletedInvoice({ amountPaid: 2000n }))

        expect(userSubscriptionRepository.upsert).not.to.have.been.called
        expect(userRepository.admitUser).to.have.been.calledOnce
      })

      it('treats an invoice whose plan was removed from the settings as an admission payment', async () => {
        invoiceRepository.findById.resolves(stubInvoice({ planId: 'retired' }))

        await service.confirmInvoice(makeCompletedInvoice({ amountPaid: 2000n }))

        expect(userSubscriptionRepository.upsert).not.to.have.been.called
        expect(userRepository.admitUser).to.have.been.calledOnce
      })

      it('reads the invoice for its purpose even when no plan is configured', async () => {
        settings.returns(plansSettings([]))

        await service.confirmInvoice(makeCompletedInvoice({ amountPaid: 2000n }))

        expect(invoiceRepository.findById).to.have.been.calledOnce
        expect(userSubscriptionRepository.findByPubkey).not.to.have.been.called
        expect(userRepository.admitUser).to.have.been.calledOnce
      })

      it('rolls back when the subscription cannot be saved, so the user is not admitted for free', async () => {
        userSubscriptionRepository.upsert.rejects(new Error('db error'))

        await expect(service.confirmInvoice(makeCompletedInvoice({ amountPaid: 5_000_000n }))).to.be.rejectedWith(
          'db error',
        )

        expect(mockTrx.rollback).to.have.been.calledOnce
        expect(mockTrx.commit).not.to.have.been.called
        expect(userRepository.admitUser).not.to.have.been.called
      })
    })

    it('rolls back the transaction and re-throws on error', async () => {
      settings.returns(makeSettings([]))
      invoiceRepository.confirmInvoice.rejects(new Error('db error'))

      await expect(service.confirmInvoice(makeCompletedInvoice())).to.be.rejectedWith('db error')

      expect(mockTrx.rollback).to.have.been.calledOnce
      expect(mockTrx.commit).not.to.have.been.called
    })
  })


  describe('sendRenewalNotification', () => {
    const renewalInvoice = () =>
      stubInvoice({
        pubkey: 'subscriber1234',
        bolt11: 'lnbc50000n1...',
        amountRequested: 5_000_000n,
        unit: InvoiceUnit.MSATS,
        expiresAt: new Date('2030-01-01T00:00:00Z'),
        planId: 'basic',
      })

    beforeEach(() => {
      settings.returns({ info: { relay_url: 'wss://relay.example.com' } })
    })

    it('tells the subscriber what is due, with the invoice to pay, until the invoice expires', async () => {
      await service.sendRenewalNotification(renewalInvoice())

      const unsigned = (eventUtils.identifyEvent as Sinon.SinonStub).firstCall.args[0]
      expect(unsigned.kind).to.equal(402)
      expect(unsigned.pubkey).to.equal('fakepubkey')
      expect(unsigned.content).to.equal('Subscription renewal due: 5000 sats')
      expect(unsigned.tags).to.deep.include(['p', 'subscriber1234'])
      expect(unsigned.tags).to.deep.include(['bolt11', 'lnbc50000n1...'])
      expect(unsigned.tags).to.deep.include(['expiration', '1893456000'])
    })

    it('keeps the unit when it is not msats', async () => {
      await service.sendRenewalNotification({ ...renewalInvoice(), unit: InvoiceUnit.SATS, amountRequested: 5000n })

      expect((eventUtils.identifyEvent as Sinon.SinonStub).firstCall.args[0].content).to.equal(
        'Subscription renewal due: 5000 sats',
      )
    })

    it('expires the notice a day out when the invoice has no expiry', async () => {
      const before = Math.floor(Date.now() / 1000)

      await service.sendRenewalNotification({ ...renewalInvoice(), expiresAt: null })

      const expiration = (eventUtils.identifyEvent as Sinon.SinonStub).firstCall.args[0].tags.find(
        (tag: string[]) => tag[0] === 'expiration',
      )
      expect(Number(expiration[1])).to.be.within(before + 86_399, before + 86_402)
    })

    it('persists and broadcasts the signed event', async () => {
      await service.sendRenewalNotification(renewalInvoice())

      expect(eventRepository.create).to.have.been.calledOnce
      expect(eventUtils.broadcastEvent).to.have.been.calledOnce
    })

    it('does not throw when the pipeline fails', async () => {
      eventRepository.create.rejects(new Error('db down'))

      await expect(service.sendRenewalNotification(renewalInvoice())).to.be.fulfilled
    })
  })

  describe('sendInvoiceUpdateNotification', () => {
    beforeEach(() => {
      settings.returns({ info: { relay_url: 'wss://relay.example.com' } })
    })

    it('throws when amountPaid is undefined', async () => {
      await expect(
        service.sendInvoiceUpdateNotification(stubInvoice({ amountPaid: undefined }))
      ).to.be.rejectedWith('Unable to notify user')
    })

    it('converts MSATS to SATS in the notification content', async () => {
      await service.sendInvoiceUpdateNotification(stubInvoice({
        unit: InvoiceUnit.MSATS,
        amountPaid: 5000n,
      }))

      const [unsignedEvent] = (eventUtils.identifyEvent as Sinon.SinonStub).firstCall.args
      expect(unsignedEvent.content).to.equal('Invoice paid: 5 sats')
    })

    it('keeps SATS amount and unit unchanged', async () => {
      await service.sendInvoiceUpdateNotification(stubInvoice({
        unit: InvoiceUnit.SATS,
        amountPaid: 100n,
      }))

      const [unsignedEvent] = (eventUtils.identifyEvent as Sinon.SinonStub).firstCall.args
      expect(unsignedEvent.content).to.equal('Invoice paid: 100 sats')
    })

    it('persists and broadcasts the signed event', async () => {
      await service.sendInvoiceUpdateNotification(stubInvoice({
        unit: InvoiceUnit.SATS,
        amountPaid: 100n,
      }))

      expect(eventRepository.create).to.have.been.calledOnce
      expect(eventUtils.broadcastEvent as Sinon.SinonStub).to.have.been.calledOnce
    })

    it('does not throw when the pipeline fails', async () => {
      ;(eventUtils.identifyEvent as Sinon.SinonStub).rejects(new Error('identify failed'))

      // otherwise() swallows the error — the method must resolve, not reject
      await service.sendInvoiceUpdateNotification(stubInvoice({ amountPaid: 100n }))

      expect(eventRepository.create).not.to.have.been.called
    })
  })

  describe('peering billing', () => {
    let peeringPaymentRepository: any
    let peeringService: PaymentsService

    const peeringRow = (overrides: Record<string, unknown> = {}) => ({
      peerPubkey: 'pubkey1234',
      direction: 'sell',
      status: 'unpaid',
      currentInvoiceId: null,
      renewalInvoiceId: null,
      periodStart: null,
      periodEnd: null,
      termAmountMsats: 21000n,
      termPeriodSeconds: 2592000,
      lastSettledInvoiceId: null,
      lastSettledAt: null,
      lastCheckedAt: null,
      lastError: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...overrides,
    })

    const makeCompletedInvoice = (overrides: Partial<Invoice> = {}): Invoice =>
      stubInvoice({
        status: InvoiceStatus.COMPLETED,
        confirmedAt: new Date('2026-11-09T12:00:00.000Z'),
        amountPaid: 21000n,
        unit: InvoiceUnit.MSATS,
        purpose: InvoicePurpose.PEERING,
        termAmountMsats: 21000n,
        termPeriodSeconds: 2592000,
        ...overrides,
      })

    beforeEach(() => {
      eventRepository.findByFilters = sandbox.stub().resolves([])
      peeringPaymentRepository = {
        lockByPeer: sandbox.stub().resolves(peeringRow()),
        save: sandbox.stub().callsFake(async (value: unknown) => value),
      }

      peeringService = new PaymentsService(
        dbClient,
        paymentsProcessor,
        userRepository,
        invoiceRepository,
        eventRepository,
        settings,
        notificationOutboxRepository,
        undefined,
        peeringPaymentRepository,
      )
    })

    it('creates a peering invoice without upserting a user', async () => {
      settings.returns({ payments: { invoiceExpirySeconds: 3600 } })
      paymentsProcessor.createInvoice.resolves({
        id: 'peering-inv',
        bolt11: 'lnbc...',
        amountRequested: 21000n,
        description: 'peering',
        unit: InvoiceUnit.MSATS,
        status: InvoiceStatus.PENDING,
        expiresAt: new Date('2099-01-01'),
        createdAt: new Date(),
      })

      const result = await peeringService.createPeeringInvoice('peer', 21000n, 'peering', 2592000)

      expect(userRepository.upsert).not.to.have.been.called
      expect(paymentsProcessor.createInvoice).to.have.been.calledWith({
        amount: 21000n,
        description: 'peering',
        requestId: 'peer',
      })
      expect(invoiceRepository.upsert.firstCall.args[0]).to.include({
        purpose: InvoicePurpose.PEERING,
        termAmountMsats: 21000n,
        termPeriodSeconds: 2592000,
        planId: null,
      })
      expect(notificationOutboxRepository.enqueue).to.have.been.calledWith(
        OperatorNotificationEventType.PEERING_INVOICE_CREATED,
        Sinon.match({ invoiceId: 'peering-inv' }),
        mockTrx,
      )
      expect(result.id).to.equal('peering-inv')
    })

    it('rejects a zero-amount peering invoice before calling the processor', async () => {
      await expect(peeringService.createPeeringInvoice('peer', 0n, 'peering', 2592000)).to.be.rejectedWith(
        'positive whole number of satoshis',
      )
      expect(paymentsProcessor.createInvoice).not.to.have.been.called
    })

    it('rejects a sub-satoshi peering invoice before calling the processor', async () => {
      await expect(peeringService.createPeeringInvoice('peer', 1500n, 'peering', 2592000)).to.be.rejectedWith(
        'positive whole number of satoshis',
      )
      expect(paymentsProcessor.createInvoice).not.to.have.been.called
    })

    it('rejects a peering invoice too large for the processor conversion', async () => {
      await expect(
        peeringService.createPeeringInvoice('peer', 10n ** 19n, 'peering', 2592000),
      ).to.be.rejectedWith('too large for the payment processors')
      expect(paymentsProcessor.createInvoice).not.to.have.been.called
    })

    it('rejects a negative peering invoice before calling the processor', async () => {
      await expect(peeringService.createPeeringInvoice('peer', -1000n, 'peering', 2592000)).to.be.rejectedWith(
        'positive whole number of satoshis',
      )
      expect(paymentsProcessor.createInvoice).not.to.have.been.called
    })

    it('rejects a peering invoice with no period before calling the processor', async () => {
      await expect(peeringService.createPeeringInvoice('peer', 21000n, 'peering', 0)).to.be.rejectedWith(
        'positive number of seconds',
      )
      expect(paymentsProcessor.createInvoice).not.to.have.been.called
    })

    it('applies a paid period and clears the open invoice pointers', async () => {
      settings.returns({ payments: { enabled: true, feeSchedules: { admission: [] } } })
      invoiceRepository.findById.resolves(
        stubInvoice({
          purpose: InvoicePurpose.PEERING,
          termAmountMsats: 21000n,
          termPeriodSeconds: 2592000,
          unit: InvoiceUnit.MSATS,
        }),
      )
      peeringPaymentRepository.lockByPeer.resolves(peeringRow({ currentInvoiceId: 'invoice-id' }))

      await peeringService.confirmInvoice(makeCompletedInvoice())

      expect(peeringPaymentRepository.save).to.have.been.calledWith(
        Sinon.match({
          status: 'active',
          currentInvoiceId: null,
          renewalInvoiceId: null,
          lastSettledInvoiceId: 'invoice-id',
        }),
        mockTrx,
      )
      expect(invoiceRepository.updatePeriod).to.have.been.calledWith(
        'invoice-id',
        Sinon.match.instanceOf(Date),
        Sinon.match.instanceOf(Date),
        mockTrx,
      )
      expect(userRepository.admitUser).not.to.have.been.called
      expect(notificationOutboxRepository.enqueue).to.have.been.calledWith(
        OperatorNotificationEventType.PEERING_INVOICE_PAID,
        Sinon.match({ invoiceId: 'invoice-id' }),
        mockTrx,
      )
      expect(mockTrx.commit).to.have.been.calledOnce
    })

    it('grants exactly one term for an overpayment and keeps the full amount on the receipt', async () => {
      settings.returns({ payments: { enabled: true, feeSchedules: { admission: [] } } })
      invoiceRepository.findById.resolves(
        stubInvoice({
          purpose: InvoicePurpose.PEERING,
          termAmountMsats: 21000n,
          termPeriodSeconds: 2592000,
          unit: InvoiceUnit.MSATS,
        }),
      )
      peeringPaymentRepository.lockByPeer.resolves(peeringRow({ currentInvoiceId: 'invoice-id' }))

      await peeringService.confirmInvoice(makeCompletedInvoice({ amountPaid: 42000n }))

      expect(invoiceRepository.confirmInvoice).to.have.been.calledWith(
        'invoice-id',
        42000n,
        Sinon.match.instanceOf(Date),
        mockTrx,
      )
      expect(peeringPaymentRepository.save).to.have.been.calledWith(
        Sinon.match({
          status: 'active',
          lastSettledInvoiceId: 'invoice-id',
        }),
        mockTrx,
      )
      expect(invoiceRepository.updatePeriod).to.have.been.calledOnce

      const [, periodStart, periodEnd] = invoiceRepository.updatePeriod.firstCall.args
      expect((periodEnd as Date).getTime() - (periodStart as Date).getTime()).to.equal(2592000 * 1000)
    })

    it('does not grant a second period for a duplicate callback', async () => {
      settings.returns({ payments: { enabled: true, feeSchedules: { admission: [] } } })
      invoiceRepository.findById.resolves(
        stubInvoice({
          purpose: InvoicePurpose.PEERING,
          termAmountMsats: 21000n,
          termPeriodSeconds: 2592000,
        }),
      )
      peeringPaymentRepository.lockByPeer.resolves(peeringRow({ lastSettledInvoiceId: 'invoice-id' }))

      await peeringService.confirmInvoice(makeCompletedInvoice())

      expect(peeringPaymentRepository.save).not.to.have.been.called
      expect(invoiceRepository.updatePeriod).not.to.have.been.called
      expect(notificationOutboxRepository.enqueue).not.to.have.been.called
      expect(mockTrx.commit).to.have.been.calledOnce
    })

    it('settles the same invoice only once across two callbacks', async () => {
      settings.returns({ payments: { enabled: true, feeSchedules: { admission: [] } } })
      let stored = stubInvoice({
        purpose: InvoicePurpose.PEERING,
        termAmountMsats: 21000n,
        termPeriodSeconds: 2592000,
        unit: InvoiceUnit.MSATS,
      })
      invoiceRepository.findById.callsFake(async () => stored)
      invoiceRepository.confirmInvoice.callsFake(async () => {
        stored = { ...stored, confirmedAt: new Date() }
      })
      peeringPaymentRepository.lockByPeer.resolves(peeringRow())

      await peeringService.confirmInvoice(makeCompletedInvoice())
      await peeringService.confirmInvoice(makeCompletedInvoice())

      expect(peeringPaymentRepository.lockByPeer).to.have.been.calledOnce
      expect(peeringPaymentRepository.save).to.have.been.calledOnce
      expect(invoiceRepository.updatePeriod).to.have.been.calledOnce
    })

    it('records an underpayment without activating access', async () => {
      settings.returns({ payments: { enabled: true, feeSchedules: { admission: [] } } })
      invoiceRepository.findById.resolves(
        stubInvoice({
          purpose: InvoicePurpose.PEERING,
          termAmountMsats: 21000n,
          termPeriodSeconds: 2592000,
        }),
      )

      await peeringService.confirmInvoice(makeCompletedInvoice({ amountPaid: 1000n }))

      expect(peeringPaymentRepository.save).to.have.been.calledWith(
        Sinon.match({ lastError: Sinon.match('underpaid') }),
        mockTrx,
      )
      expect(invoiceRepository.updatePeriod).not.to.have.been.called
      expect(notificationOutboxRepository.enqueue).to.have.been.calledWith(
        OperatorNotificationEventType.PEERING_INVOICE_FAILED,
        Sinon.match({ reason: 'underpaid' }),
        mockTrx,
      )
    })

    it('publishes peering invoice events with the peering and invoice-id tags', async () => {
      settings.returns({ info: { relay_url: 'wss://relay.example.com' } })
      const invoice = stubInvoice({
        id: 'peering-inv',
        purpose: InvoicePurpose.PEERING,
        termPeriodSeconds: 2592000,
      })

      await peeringService.sendPeeringInvoiceNotification(invoice)

      const [unsignedEvent] = (eventUtils.identifyEvent as Sinon.SinonStub).firstCall.args
      expect(unsignedEvent.tags).to.deep.include.members([
        ['p', invoice.pubkey],
        ['t', 'peering'],
        ['bolt11', invoice.bolt11],
        ['i', invoice.id],
      ])
      expect(unsignedEvent.content).to.include('Paid peering invoice')
    })

    it('does not republish an invoice that already has a stored notification', async () => {
      settings.returns({ info: { relay_url: 'wss://relay.example.com' } })
      const invoice = stubInvoice({ id: 'peering-inv', purpose: InvoicePurpose.PEERING })
      eventRepository.findByFilters.resolves([{ event_id: Buffer.alloc(32) }])

      await peeringService.ensurePeeringInvoiceNotification(invoice)

      expect(eventUtils.identifyEvent).not.to.have.been.called
      expect(eventRepository.findByFilters).to.have.been.calledWith(
        [Sinon.match({ kinds: [402], '#i': ['peering-inv'], limit: 1 })],
        { excludeDeleted: true },
      )
    })

    it('publishes when no stored notification exists', async () => {
      settings.returns({ info: { relay_url: 'wss://relay.example.com' } })
      const invoice = stubInvoice({ id: 'peering-inv', purpose: InvoicePurpose.PEERING })

      await peeringService.ensurePeeringInvoiceNotification(invoice)

      expect(eventUtils.identifyEvent).to.have.been.calledOnce
    })

    it('does not grant another period when an older confirmed invoice callback is redelivered', async () => {
      settings.returns({ payments: { enabled: true, feeSchedules: { admission: [] } } })
      invoiceRepository.findById.resolves(
        stubInvoice({
          id: 'older-invoice',
          purpose: InvoicePurpose.PEERING,
          termAmountMsats: 21000n,
          termPeriodSeconds: 2592000,
          confirmedAt: new Date('2026-10-01T00:00:00.000Z'),
        }),
      )
      peeringPaymentRepository.lockByPeer.resolves(peeringRow({ lastSettledInvoiceId: 'newer-invoice' }))

      await peeringService.confirmInvoice(makeCompletedInvoice({ id: 'older-invoice' }))

      expect(peeringPaymentRepository.lockByPeer).not.to.have.been.called
      expect(peeringPaymentRepository.save).not.to.have.been.called
      expect(invoiceRepository.updatePeriod).not.to.have.been.called
      expect(notificationOutboxRepository.enqueue).not.to.have.been.called
      expect(mockTrx.commit).to.have.been.calledOnce
    })

    it('extends a running period from its existing end', async () => {
      const existingPeriodEnd = new Date('2026-11-20T00:00:00.000Z')
      const confirmedAt = new Date('2026-11-09T12:00:00.000Z')
      settings.returns({ payments: { enabled: true, feeSchedules: { admission: [] } } })
      invoiceRepository.findById.resolves(
        stubInvoice({
          purpose: InvoicePurpose.PEERING,
          termAmountMsats: 21000n,
          termPeriodSeconds: 2592000,
        }),
      )
      peeringPaymentRepository.lockByPeer.resolves(
        peeringRow({
          status: 'active',
          currentInvoiceId: 'invoice-id',
          periodEnd: existingPeriodEnd,
        }),
      )

      await peeringService.confirmInvoice(makeCompletedInvoice({ confirmedAt }))

      const [, periodStart, periodEnd] = invoiceRepository.updatePeriod.firstCall.args
      expect(periodStart).to.equal(existingPeriodEnd)
      expect((periodEnd as Date).getTime()).to.equal(existingPeriodEnd.getTime() + 2592000 * 1000)
    })

    it('rolls back when saving the peer billing row fails', async () => {
      settings.returns({ payments: { enabled: true, feeSchedules: { admission: [] } } })
      invoiceRepository.findById.resolves(
        stubInvoice({
          purpose: InvoicePurpose.PEERING,
          termAmountMsats: 21000n,
          termPeriodSeconds: 2592000,
        }),
      )
      peeringPaymentRepository.save.rejects(new Error('peer save failed'))

      await expect(peeringService.confirmInvoice(makeCompletedInvoice())).to.be.rejectedWith('peer save failed')

      expect(mockTrx.rollback).to.have.been.calledOnce
      expect(invoiceRepository.updatePeriod).not.to.have.been.called
    })

    it('rolls back when updating the invoice period fails', async () => {
      settings.returns({ payments: { enabled: true, feeSchedules: { admission: [] } } })
      invoiceRepository.findById.resolves(
        stubInvoice({
          purpose: InvoicePurpose.PEERING,
          termAmountMsats: 21000n,
          termPeriodSeconds: 2592000,
        }),
      )
      invoiceRepository.updatePeriod.rejects(new Error('period update failed'))

      await expect(peeringService.confirmInvoice(makeCompletedInvoice())).to.be.rejectedWith('period update failed')

      expect(mockTrx.rollback).to.have.been.calledOnce
    })

    it('rolls back a peering invoice when the processor fails', async () => {
      settings.returns({ payments: { invoiceExpirySeconds: 3600 } })
      paymentsProcessor.createInvoice.rejects(new Error('processor failed'))

      await expect(peeringService.createPeeringInvoice('peer', 21000n, 'peering', 2592000)).to.be.rejectedWith(
        'processor failed',
      )

      expect(mockTrx.rollback).to.have.been.calledOnce
      expect(mockTrx.commit).not.to.have.been.called
    })
  })

})
