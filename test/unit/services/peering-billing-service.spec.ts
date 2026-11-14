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

    it('returns no invoice for settlement-free peering', async () => {
      settingsState.peering!.terms = []

      const result = await service.ensureInvoice(peer, { now })

      expect(result).to.be.undefined
      expect(paymentRepository.ensureRow).not.to.have.been.called
    })
  })

  describe('processLifecycle', () => {
    it('lapses an expired period after rechecking the pending invoice', async () => {
      const expired = payment({
        status: PeeringPaymentStatus.ACTIVE,
        periodEnd: new Date(now.getTime() - 1000),
      })
      paymentRepository.findPeriodEnded.resolves([expired])
      paymentRepository.findByPeer.resolves(expired)
      paymentRepository.lockByPeer.resolves(expired)

      const changed = await service.processLifecycle(now)

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

      const changed = await service.processLifecycle(now)

      expect(changed).to.equal(0)
      expect(paymentRepository.save).not.to.have.been.called
    })
  })

  describe('recheckPendingInvoice', () => {
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
  })

  describe('handleInvoiceExpired', () => {
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
  })
})
