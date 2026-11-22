import chai from 'chai'
import chaiAsPromised from 'chai-as-promised'
import Sinon from 'sinon'
import sinonChai from 'sinon-chai'

import { Invoice, InvoicePurpose, InvoiceStatus, InvoiceUnit } from '../../../src/@types/invoice'
import { OperatorNotificationEventType } from '../../../src/@types/operator-notifications'
import { PeeringPayment, PeeringPaymentDirection, PeeringPaymentStatus } from '../../../src/@types/peering'
import { Settings } from '../../../src/@types/settings'
import { PeeringBillingService } from '../../../src/services/peering-billing-service'
import { PeeringInvoiceCooldownError } from '../../../src/utils/peering-billing'

chai.use(sinonChai)
chai.use(chaiAsPromised)
const { expect } = chai

describe('PeeringBillingService', () => {
  const peer = 'a'.repeat(64)
  const now = new Date('2026-11-09T12:00:00.000Z')

  let sandbox: Sinon.SinonSandbox
  let service: PeeringBillingService
  let mockTrx: { commit: Sinon.SinonStub; rollback: Sinon.SinonStub }
  let dbClient: any
  let paymentRepository: any
  let invoiceRepository: any
  let paymentsService: any
  let notificationOutboxRepository: any
  let settingsState: Settings
  let revokePeer: Sinon.SinonStub

  const payment = (overrides: Partial<PeeringPayment> = {}): PeeringPayment => ({
    peerPubkey: peer,
    direction: PeeringPaymentDirection.SELL,
    status: PeeringPaymentStatus.UNPAID,
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
    createdAt: now,
    updatedAt: now,
    ...overrides,
  })

  const invoice = (overrides: Partial<Invoice> = {}): Invoice => ({
    id: 'inv-1',
    pubkey: peer,
    bolt11: 'lnbc...',
    amountRequested: 21000n,
    unit: InvoiceUnit.MSATS,
    status: InvoiceStatus.PENDING,
    description: 'peering',
    confirmedAt: null,
    expiresAt: new Date(now.getTime() + 60_000),
    updatedAt: now,
    createdAt: now,
    purpose: InvoicePurpose.PEERING,
    termAmountMsats: 21000n,
    termPeriodSeconds: 2592000,
    ...overrides,
  })

  beforeEach(() => {
    sandbox = Sinon.createSandbox()
    mockTrx = {
      commit: sandbox.stub().resolves(),
      rollback: sandbox.stub().resolves(),
    }
    dbClient = { transaction: sandbox.stub().resolves(mockTrx) }

    paymentRepository = {
      findByPeer: sandbox.stub(),
      ensureRow: sandbox.stub().resolves(),
      lockByPeer: sandbox.stub(),
      save: sandbox.stub().callsFake(async (value) => value),
      recordCheck: sandbox.stub().resolves(),
      list: sandbox.stub().resolves([]),
      findDueForRenewal: sandbox.stub().resolves([]),
      findPeriodEnded: sandbox.stub().resolves([]),
    }

    invoiceRepository = {
      findById: sandbox.stub().resolves(undefined),
      updateStatus: sandbox.stub().resolves(),
      updatePeriod: sandbox.stub().resolves(),
    }

    paymentsService = {
      createPeeringInvoice: sandbox.stub(),
      sendPeeringInvoiceNotification: sandbox.stub().resolves(),
      ensurePeeringInvoiceNotification: sandbox.stub().resolves(),
      getInvoiceFromPaymentsProcessor: sandbox.stub(),
      confirmInvoice: sandbox.stub().resolves(),
    }

    notificationOutboxRepository = {
      enqueue: sandbox.stub().resolves(),
    }

    settingsState = {
      info: { name: 'Test Relay' },
      payments: { enabled: true },
      peering: {
        enabled: true,
        terms: [{ amount: 21000, unit: 'msats', period: 2592000 }],
      },
    } as Settings

    revokePeer = sandbox.stub()

    service = new PeeringBillingService(
      dbClient,
      paymentRepository,
      invoiceRepository,
      paymentsService,
      notificationOutboxRepository,
      () => settingsState,
      revokePeer,
    )
  })

  afterEach(() => sandbox.restore())

  describe('getAccess', () => {
    it('allows settlement-free peering without reading billing state', async () => {
      settingsState.peering!.terms = []

      const access = await service.getAccess(peer, { now })

      expect(access).to.include({ allowed: true, status: 'free' })
      expect(paymentRepository.findByPeer).not.to.have.been.called
    })

    it('denies a peer with no invoice yet', async () => {
      paymentRepository.findByPeer.resolves(undefined)

      const access = await service.getAccess(peer, { now })

      expect(access.allowed).to.equal(false)
      expect(access.status).to.equal(PeeringPaymentStatus.UNPAID)
    })

    it('allows an active period that has not ended', async () => {
      paymentRepository.findByPeer.resolves(
        payment({
          status: PeeringPaymentStatus.ACTIVE,
          periodStart: new Date(now.getTime() - 1000),
          periodEnd: new Date(now.getTime() + 1000),
        }),
      )

      const access = await service.getAccess(peer, { now })

      expect(access.allowed).to.equal(true)
      expect(access.status).to.equal(PeeringPaymentStatus.ACTIVE)
    })

    it('allows a running renewal-pending period', async () => {
      paymentRepository.findByPeer.resolves(
        payment({
          status: PeeringPaymentStatus.RENEWAL_PENDING,
          periodEnd: new Date(now.getTime() + 1000),
        }),
      )

      const access = await service.getAccess(peer, { now })

      expect(access.allowed).to.equal(true)
      expect(access.status).to.equal(PeeringPaymentStatus.RENEWAL_PENDING)
    })

    it('denies a lapsed period', async () => {
      paymentRepository.findByPeer.resolves(
        payment({
          status: PeeringPaymentStatus.LAPSED,
          periodEnd: new Date(now.getTime() - 1000),
        }),
      )

      const access = await service.getAccess(peer, { now })

      expect(access.allowed).to.equal(false)
      expect(access.reason).to.include('lapsed')
    })

    it('denies access when the paid term is invalid', async () => {
      settingsState.peering!.terms = [{ amount: 1500, unit: 'msats', period: 2592000 }]

      const access = await service.getAccess(peer, { now })

      expect(access.allowed).to.equal(false)
      expect(access.status).to.equal('unconfigured')
    })

    it('rechecks a pending invoice before denying access', async () => {
      const invoiced = payment({ status: PeeringPaymentStatus.INVOICED, currentInvoiceId: 'inv-1' })
      paymentRepository.findByPeer
        .onFirstCall()
        .resolves(invoiced)
        .onSecondCall()
        .resolves(invoiced)
        .onThirdCall()
        .resolves(
          payment({
            status: PeeringPaymentStatus.ACTIVE,
            periodEnd: new Date(now.getTime() + 1000),
          }),
        )
      invoiceRepository.findById.resolves(invoice())
      paymentsService.getInvoiceFromPaymentsProcessor.resolves({
        status: InvoiceStatus.COMPLETED,
        confirmedAt: now,
        amountPaid: 21000n,
      })

      const access = await service.getAccess(peer, { now, recheck: true })

      expect(access.allowed).to.equal(true)
      expect(paymentsService.confirmInvoice).to.have.been.calledOnce
    })
  })

  describe('ensureInvoice', () => {
    it('creates and publishes a first invoice', async () => {
      paymentRepository.lockByPeer.resolves(payment())
      paymentsService.createPeeringInvoice.resolves(invoice())

      const result = await service.ensureInvoice(peer, { now })

      expect(result?.id).to.equal('inv-1')
      expect(paymentsService.createPeeringInvoice).to.have.been.calledWith(
        peer,
        21000n,
        Sinon.match.string,
        2592000,
        mockTrx,
      )
      expect(paymentRepository.save).to.have.been.calledWith(
        Sinon.match({
          status: PeeringPaymentStatus.INVOICED,
          currentInvoiceId: 'inv-1',
          renewalInvoiceId: null,
        }),
        mockTrx,
      )
      expect(mockTrx.commit).to.have.been.calledOnce
      expect(paymentsService.ensurePeeringInvoiceNotification).to.have.been.calledWith(result)
    })

    it('reuses an open invoice instead of charging the peer twice', async () => {
      paymentRepository.lockByPeer.resolves(payment({ currentInvoiceId: 'inv-1' }))
      invoiceRepository.findById.resolves(invoice())

      const result = await service.ensureInvoice(peer, { now })

      expect(result?.id).to.equal('inv-1')
      expect(paymentsService.createPeeringInvoice).not.to.have.been.called
      expect(mockTrx.commit).to.have.been.calledOnce
    })

    it('retires an expired invoice and applies the reissue cooldown', async () => {
      paymentRepository.lockByPeer.resolves(payment({ currentInvoiceId: 'inv-1' }))
      invoiceRepository.findById.resolves(invoice({ expiresAt: new Date(now.getTime() - 1000) }))

      await expect(service.ensureInvoice(peer, { now })).to.be.rejectedWith(PeeringInvoiceCooldownError)

      expect(invoiceRepository.updateStatus).to.have.been.calledWith(
        { id: 'inv-1', status: InvoiceStatus.EXPIRED },
        mockTrx,
      )
      expect(paymentsService.createPeeringInvoice).not.to.have.been.called
      expect(mockTrx.rollback).to.have.been.calledOnce
    })

    it('issues a renewal invoice for a running period', async () => {
      paymentRepository.lockByPeer.resolves(
        payment({
          status: PeeringPaymentStatus.ACTIVE,
          periodEnd: new Date(now.getTime() + 86_400_000),
        }),
      )
      paymentsService.createPeeringInvoice.resolves(invoice({ id: 'renewal-1' }))

      const result = await service.ensureInvoice(peer, { now, renewal: true })

      expect(result?.id).to.equal('renewal-1')
      expect(paymentRepository.save).to.have.been.calledWith(
        Sinon.match({
          status: PeeringPaymentStatus.RENEWAL_PENDING,
          renewalInvoiceId: 'renewal-1',
        }),
        mockTrx,
      )
    })

    it('does not mint another period outside the renewal window', async () => {
      paymentRepository.lockByPeer.resolves(
        payment({
          status: PeeringPaymentStatus.ACTIVE,
          periodEnd: new Date(now.getTime() + 10 * 86_400_000),
        }),
      )

      const result = await service.ensureInvoice(peer, { now })

      expect(result).to.be.undefined
      expect(paymentsService.createPeeringInvoice).not.to.have.been.called
      expect(mockTrx.rollback).to.have.been.calledOnce
    })

    it('mints a renewal inside the renewal window without a reconnect override', async () => {
      paymentRepository.lockByPeer.resolves(
        payment({
          status: PeeringPaymentStatus.ACTIVE,
          periodEnd: new Date(now.getTime() + 86_400_000),
        }),
      )
      paymentsService.createPeeringInvoice.resolves(invoice({ id: 'renewal-1' }))

      const result = await service.ensureInvoice(peer, { now })

      expect(result?.id).to.equal('renewal-1')
      expect(paymentRepository.save).to.have.been.calledWith(
        Sinon.match({
          status: PeeringPaymentStatus.RENEWAL_PENDING,
          renewalInvoiceId: 'renewal-1',
        }),
        mockTrx,
      )
    })

    it('returns no invoice for settlement-free peering', async () => {
      settingsState.peering!.terms = []

      const result = await service.ensureInvoice(peer, { now })

      expect(result).to.be.undefined
      expect(paymentRepository.ensureRow).not.to.have.been.called
    })

    it('fails closed when payments are disabled', async () => {
      settingsState.payments!.enabled = false

      await expect(service.ensureInvoice(peer, { now })).to.be.rejectedWith(
        'paid peering requires payments to be enabled',
      )
    })

    it('returns the settled invoice after a recheck', async () => {
      paymentRepository.findByPeer
        .onFirstCall()
        .resolves(payment({ currentInvoiceId: 'inv-1' }))
        .onSecondCall()
        .resolves(payment({ lastSettledInvoiceId: 'inv-1' }))
      invoiceRepository.findById
        .onFirstCall()
        .resolves(invoice({ status: InvoiceStatus.PENDING }))
        .onSecondCall()
        .resolves(invoice({ status: InvoiceStatus.COMPLETED, confirmedAt: now }))
      paymentsService.getInvoiceFromPaymentsProcessor.resolves({
        status: InvoiceStatus.COMPLETED,
        confirmedAt: now,
        amountPaid: 21000n,
      })

      const result = await service.ensureInvoice(peer, { now })

      expect(result?.id).to.equal('inv-1')
      expect(paymentsService.confirmInvoice).to.have.been.calledOnce
      expect(paymentsService.ensurePeeringInvoiceNotification).to.have.been.calledOnce
      expect(paymentsService.createPeeringInvoice).not.to.have.been.called
    })
  })

  describe('recheckPendingInvoice', () => {
    it('does nothing without a payment row or open invoice', async () => {
      paymentRepository.findByPeer.resolves(undefined)

      expect(await service.recheckPendingInvoice(peer, now, true)).to.equal(false)
    })

    it('honours the recheck cooldown', async () => {
      paymentRepository.findByPeer.resolves(
        payment({ currentInvoiceId: 'inv-1', lastCheckedAt: new Date(now.getTime() - 1000) }),
      )

      expect(await service.recheckPendingInvoice(peer, now)).to.equal(false)
      expect(paymentsService.getInvoiceFromPaymentsProcessor).not.to.have.been.called
    })

    it('records only the processor check and leaves settlement columns alone', async () => {
      paymentRepository.findByPeer.resolves(
        payment({ status: PeeringPaymentStatus.INVOICED, currentInvoiceId: 'inv-1' }),
      )
      invoiceRepository.findById.resolves(
        invoice({ status: InvoiceStatus.PENDING, expiresAt: new Date(now.getTime() - 1000) }),
      )
      paymentsService.getInvoiceFromPaymentsProcessor.resolves({ status: InvoiceStatus.PENDING })

      const settled = await service.recheckPendingInvoice(peer, now, true)

      expect(settled).to.be.false
      expect(paymentRepository.recordCheck).to.have.been.calledWith(peer, now, 'processor status: pending')
      expect(paymentRepository.save).not.to.have.been.called
    })

    it('settles a locally expired invoice when the processor reports payment', async () => {
      paymentRepository.findByPeer.resolves(
        payment({ status: PeeringPaymentStatus.INVOICED, currentInvoiceId: 'inv-1' }),
      )
      invoiceRepository.findById.resolves(
        invoice({ status: InvoiceStatus.PENDING, expiresAt: new Date(now.getTime() - 1000) }),
      )
      paymentsService.getInvoiceFromPaymentsProcessor.resolves({
        status: InvoiceStatus.COMPLETED,
        confirmedAt: now,
        amountPaid: 21000n,
      })

      const settled = await service.recheckPendingInvoice(peer, now, true)

      expect(settled).to.be.true
      expect(paymentsService.confirmInvoice).to.have.been.calledWith(
        Sinon.match({ id: 'inv-1', status: InvoiceStatus.COMPLETED }),
      )
      expect(paymentRepository.recordCheck).not.to.have.been.called
    })

    it('records a processor failure on the peer row', async () => {
      paymentRepository.findByPeer.resolves(payment({ currentInvoiceId: 'inv-1' }))
      invoiceRepository.findById.resolves(invoice())
      paymentsService.getInvoiceFromPaymentsProcessor.rejects(new Error('processor down'))

      const settled = await service.recheckPendingInvoice(peer, now, true)

      expect(settled).to.be.false
      expect(paymentRepository.recordCheck).to.have.been.calledWith(peer, now, 'processor down')
    })
  })

  describe('processLapses', () => {
    it('lapses an expired period after rechecking the pending invoice', async () => {
      const expired = payment({
        status: PeeringPaymentStatus.ACTIVE,
        periodEnd: new Date(now.getTime() - 1000),
      })
      paymentRepository.findPeriodEnded.resolves([expired])
      paymentRepository.findByPeer.resolves(expired)
      paymentRepository.lockByPeer.resolves(expired)

      const changed = await service.processLapses(now)

      expect(changed).to.equal(1)
      expect(paymentRepository.save).to.have.been.calledWith(
        Sinon.match({
          status: PeeringPaymentStatus.LAPSED,
          currentInvoiceId: null,
          renewalInvoiceId: null,
        }),
        mockTrx,
      )
      expect(notificationOutboxRepository.enqueue).to.have.been.calledWith(
        OperatorNotificationEventType.PEERING_ACCESS_LAPSED,
        Sinon.match({ pubkey: peer }),
        mockTrx,
      )
      expect(revokePeer).to.have.been.calledWith(peer)
    })

    it('does not lapse while the period is still running', async () => {
      paymentRepository.findPeriodEnded.resolves([])

      const changed = await service.processLapses(now)

      expect(changed).to.equal(0)
      expect(paymentRepository.save).not.to.have.been.called
    })

    it('does nothing for settlement-free peering', async () => {
      settingsState.peering!.terms = []

      expect(await service.processLapses(now)).to.equal(0)
      expect(paymentRepository.findPeriodEnded).not.to.have.been.called
    })

    it('does not lapse a peer that paid before the recheck', async () => {
      const expired = payment({
        status: PeeringPaymentStatus.ACTIVE,
        periodEnd: new Date(now.getTime() - 1000),
        currentInvoiceId: 'inv-1',
      })
      paymentRepository.findPeriodEnded.resolves([expired])
      paymentRepository.findByPeer.resolves(expired)
      invoiceRepository.findById.resolves(invoice())
      paymentsService.getInvoiceFromPaymentsProcessor.resolves({
        status: InvoiceStatus.COMPLETED,
        confirmedAt: now,
      })

      const changed = await service.processLapses(now)

      expect(changed).to.equal(1)
      expect(paymentRepository.lockByPeer).not.to.have.been.called
      expect(notificationOutboxRepository.enqueue).not.to.have.been.calledWith(
        OperatorNotificationEventType.PEERING_ACCESS_LAPSED,
        Sinon.match.any,
        Sinon.match.any,
      )
    })

    it('keeps the peer active when the lapse transaction fails', async () => {
      const expired = payment({
        status: PeeringPaymentStatus.ACTIVE,
        periodEnd: new Date(now.getTime() - 1000),
      })
      paymentRepository.findPeriodEnded.resolves([expired])
      paymentRepository.findByPeer.resolves(expired)
      paymentRepository.lockByPeer.rejects(new Error('deadlock'))

      expect(await service.processLapses(now)).to.equal(0)
      expect(mockTrx.rollback).to.have.been.calledOnce
      expect(notificationOutboxRepository.enqueue).not.to.have.been.called
      expect(revokePeer).not.to.have.been.called
    })

    it('does not fail the pass when revoking the live sockets throws', async () => {
      const expired = payment({
        status: PeeringPaymentStatus.ACTIVE,
        periodEnd: new Date(now.getTime() - 1000),
      })
      paymentRepository.findPeriodEnded.resolves([expired])
      paymentRepository.findByPeer.resolves(expired)
      paymentRepository.lockByPeer.resolves(expired)
      revokePeer.throws(new Error('cluster down'))

      expect(await service.processLapses(now)).to.equal(1)
    })
  })

  describe('handleInvoiceExpired', () => {
    it('ignores non-peering invoices', async () => {
      await service.handleInvoiceExpired(invoice({ purpose: InvoicePurpose.ADMISSION }))

      expect(paymentRepository.findByPeer).not.to.have.been.called
    })

    it('ignores an invoice that is not the current pointer', async () => {
      paymentRepository.findByPeer.resolves(payment({ currentInvoiceId: 'other' }))

      await service.handleInvoiceExpired(invoice())

      expect(paymentRepository.save).not.to.have.been.called
    })

    it('ignores an invoice when the peer has no billing row', async () => {
      paymentRepository.findByPeer.resolves(undefined)

      await service.handleInvoiceExpired(invoice())

      expect(paymentRepository.save).not.to.have.been.called
      expect(notificationOutboxRepository.enqueue).not.to.have.been.called
    })

    it('does not fail the worker when the failure alert cannot be enqueued', async () => {
      paymentRepository.findByPeer.resolves(
        payment({ status: PeeringPaymentStatus.INVOICED, currentInvoiceId: 'inv-1' }),
      )
      notificationOutboxRepository.enqueue.rejects(new Error('outbox down'))

      await service.handleInvoiceExpired(invoice())

      expect(paymentRepository.save).to.have.been.called
    })

    it('clears the pointer and records a failure', async () => {
      paymentRepository.findByPeer.resolves(
        payment({ status: PeeringPaymentStatus.INVOICED, currentInvoiceId: 'inv-1' }),
      )

      await service.handleInvoiceExpired(invoice())

      expect(paymentRepository.save).to.have.been.calledWith(
        Sinon.match({
          status: PeeringPaymentStatus.UNPAID,
          currentInvoiceId: null,
        }),
      )
      expect(notificationOutboxRepository.enqueue).to.have.been.calledWith(
        OperatorNotificationEventType.PEERING_INVOICE_FAILED,
        Sinon.match({ invoiceId: 'inv-1', reason: 'expired' }),
      )
    })

    it('clears a renewal pointer without changing the current status', async () => {
      paymentRepository.findByPeer.resolves(
        payment({
          status: PeeringPaymentStatus.ACTIVE,
          currentInvoiceId: 'current',
          renewalInvoiceId: 'inv-1',
        }),
      )

      await service.handleInvoiceExpired(invoice())

      expect(paymentRepository.save).to.have.been.calledWith(
        Sinon.match({
          status: PeeringPaymentStatus.ACTIVE,
          currentInvoiceId: 'current',
          renewalInvoiceId: null,
        }),
      )
    })
  })

  describe('processLifecycle', () => {
    it('issues renewals and then lapses ended periods', async () => {
      const running = payment({
        status: PeeringPaymentStatus.ACTIVE,
        periodEnd: new Date(now.getTime() + 86_400_000),
      })
      paymentRepository.findDueForRenewal.resolves([running])
      paymentRepository.findPeriodEnded.resolves([])
      sandbox.stub(service, 'ensureInvoice').resolves(invoice({ id: 'renewal-1' }))

      const changed = await service.processLifecycle(now)

      expect(changed).to.equal(1)
      expect(service.ensureInvoice).to.have.been.calledWith(peer, { now, renewal: true })
    })

    it('runs the ended-period sweep', async () => {
      const expired = payment({
        status: PeeringPaymentStatus.ACTIVE,
        periodEnd: new Date(now.getTime() - 1000),
      })
      paymentRepository.findDueForRenewal.resolves([])
      paymentRepository.findPeriodEnded.resolves([expired])
      paymentRepository.findByPeer.resolves(expired)
      paymentRepository.lockByPeer.resolves(expired)

      const changed = await service.processLifecycle(now)

      expect(changed).to.equal(1)
      expect(paymentRepository.save).to.have.been.calledWith(
        Sinon.match({ status: PeeringPaymentStatus.LAPSED }),
        mockTrx,
      )
    })

    it('does nothing when the paid term is invalid', async () => {
      settingsState.peering!.terms = [{ amount: 1500, unit: 'msats', period: 2592000 }]

      expect(await service.processLifecycle(now)).to.equal(0)
      expect(paymentRepository.findDueForRenewal).not.to.have.been.called
      expect(paymentRepository.findPeriodEnded).not.to.have.been.called
    })

    it('does nothing for settlement-free peering', async () => {
      settingsState.peering!.terms = []

      expect(await service.processLifecycle(now)).to.equal(0)
      expect(paymentRepository.findDueForRenewal).not.to.have.been.called
    })

    it('does not renew a row whose period already ended', async () => {
      paymentRepository.findDueForRenewal.resolves([
        payment({
          status: PeeringPaymentStatus.ACTIVE,
          periodEnd: new Date(now.getTime() - 1000),
        }),
      ])
      paymentRepository.findPeriodEnded.resolves([])
      const ensureInvoice = sandbox.stub(service, 'ensureInvoice').resolves(invoice())

      expect(await service.processLifecycle(now)).to.equal(0)
      expect(ensureInvoice).not.to.have.been.called
    })

    it('treats a reissue cooldown as handled without failing the pass', async () => {
      paymentRepository.findDueForRenewal.resolves([
        payment({
          status: PeeringPaymentStatus.ACTIVE,
          periodEnd: new Date(now.getTime() + 1000),
        }),
      ])
      paymentRepository.findPeriodEnded.resolves([])
      sandbox.stub(service, 'ensureInvoice').rejects(new PeeringInvoiceCooldownError(15))

      expect(await service.processLifecycle(now)).to.equal(0)
    })

    it('keeps the pass alive when issuing one renewal fails', async () => {
      paymentRepository.findDueForRenewal.resolves([
        payment({
          status: PeeringPaymentStatus.ACTIVE,
          periodEnd: new Date(now.getTime() + 1000),
        }),
      ])
      paymentRepository.findPeriodEnded.resolves([])
      sandbox.stub(service, 'ensureInvoice').rejects(new Error('invoice provider down'))

      expect(await service.processLifecycle(now)).to.equal(0)
    })

    it('adds renewals and lapses into one count', async () => {
      paymentRepository.findDueForRenewal.resolves([
        payment({
          status: PeeringPaymentStatus.ACTIVE,
          periodEnd: new Date(now.getTime() + 1000),
        }),
      ])
      paymentRepository.findPeriodEnded.resolves([])
      sandbox.stub(service, 'ensureInvoice').resolves(invoice({ id: 'renewal-1' }))
      sandbox.stub(service, 'processLapses').resolves(2)

      expect(await service.processLifecycle(now)).to.equal(3)
    })
  })
})
