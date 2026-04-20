import chai from 'chai'
import chaiAsPromised from 'chai-as-promised'
import Sinon from 'sinon'
import sinonChai from 'sinon-chai'

chai.use(sinonChai)
chai.use(chaiAsPromised)

import * as eventUtils from '../../../src/utils/event'
import { Invoice, InvoiceStatus, InvoiceUnit } from '../../../src/@types/invoice'
import { PaymentsService } from '../../../src/services/payments-service'

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
      findPendingInvoices: sandbox.stub(),
      upsert: sandbox.stub().resolves(),
      updateStatus: sandbox.stub(),
      confirmInvoice: sandbox.stub().resolves(),
    }

    eventRepository = {
      create: sandbox.stub().resolves(),
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


    it('rolls back the transaction and re-throws on error', async () => {
      settings.returns(makeSettings([]))
      invoiceRepository.confirmInvoice.rejects(new Error('db error'))

      await expect(service.confirmInvoice(makeCompletedInvoice())).to.be.rejectedWith('db error')

      expect(mockTrx.rollback).to.have.been.calledOnce
      expect(mockTrx.commit).not.to.have.been.called
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
})
