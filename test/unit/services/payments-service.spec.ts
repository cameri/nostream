import chai from 'chai'
import chaiAsPromised from 'chai-as-promised'
import Sinon from 'sinon'
import sinonChai from 'sinon-chai'

chai.use(sinonChai)
chai.use(chaiAsPromised)

const { expect } = chai

import { EventKinds, EventTags } from '../../../src/constants/base'
import { FeeSchedule, Settings } from '../../../src/@types/settings'
import { Invoice, InvoiceStatus, InvoiceUnit } from '../../../src/@types/invoice'
import { PaymentsService } from '../../../src/services/payments-service'

describe('PaymentsService', () => {
  let sandbox: Sinon.SinonSandbox
  let service: PaymentsService
  let dbClient: any
  let paymentsProcessor: any
  let userRepository: any
  let invoiceRepository: any
  let eventRepository: any
  let settingsFn: Sinon.SinonStub
  let transactionStub: any
  let origEnv: NodeJS.ProcessEnv

  beforeEach(() => {
    sandbox = Sinon.createSandbox()
    origEnv = { ...process.env }
    process.env = {
      SECRET: 'changeme',
    }

    transactionStub = {
      commit: sandbox.stub().resolves(),
      rollback: sandbox.stub().resolves(),
    }

    dbClient = {
      transaction: sandbox.stub().resolves(transactionStub),
    }

    paymentsProcessor = {
      getInvoice: sandbox.stub(),
      createInvoice: sandbox.stub(),
    }

    userRepository = {
      upsert: sandbox.stub().resolves(1),
    }

    invoiceRepository = {
      findPendingInvoices: sandbox.stub(),
      updateStatus: sandbox.stub(),
      confirmInvoice: sandbox.stub().resolves(),
      upsert: sandbox.stub().resolves(1),
    }

    eventRepository = {
      create: sandbox.stub().resolves(1),
    }

    settingsFn = sandbox.stub().returns({
      info: { relay_url: 'wss://relay.test' },
      payments: {
        enabled: true,
        processor: 'lnbits',
        feeSchedules: {
          admission: [],
          publication: [],
        },
      },
    } as unknown as Settings)

    service = new PaymentsService(
      dbClient,
      paymentsProcessor,
      userRepository,
      invoiceRepository,
      eventRepository,
      settingsFn,
    )
  })

  afterEach(() => {
    process.env = origEnv
    sandbox.restore()
  })

  describe('getPendingInvoices', () => {
    it('delegates to invoiceRepository.findPendingInvoices', async () => {
      const invoices = [{ id: 'inv1' }] as Invoice[]
      invoiceRepository.findPendingInvoices.resolves(invoices)

      const result = await service.getPendingInvoices()

      expect(invoiceRepository.findPendingInvoices).to.have.been.calledOnceWithExactly(0, 10)
      expect(result).to.deep.equal(invoices)
    })

    it('re-throws error from repository', async () => {
      invoiceRepository.findPendingInvoices.rejects(new Error('db error'))

      await expect(service.getPendingInvoices()).to.be.rejectedWith('db error')
    })
  })

  describe('getInvoiceFromPaymentsProcessor', () => {
    it('passes string directly to paymentsProcessor.getInvoice', async () => {
      const expected = { id: 'inv1', status: InvoiceStatus.COMPLETED }
      paymentsProcessor.getInvoice.resolves(expected)

      const result = await service.getInvoiceFromPaymentsProcessor('payment_hash_123')

      expect(paymentsProcessor.getInvoice).to.have.been.calledOnceWithExactly('payment_hash_123')
      expect(result).to.deep.equal(expected)
    })

    it('passes full invoice when verifyURL is set', async () => {
      const invoice = { id: 'inv1', verifyURL: 'https://verify.test' } as Invoice
      paymentsProcessor.getInvoice.resolves({ id: 'inv1' })

      await service.getInvoiceFromPaymentsProcessor(invoice)

      expect(paymentsProcessor.getInvoice).to.have.been.calledOnceWithExactly(invoice)
    })

    it('passes invoice.id when verifyURL is not set', async () => {
      const invoice = { id: 'inv1' } as Invoice
      paymentsProcessor.getInvoice.resolves({ id: 'inv1' })

      await service.getInvoiceFromPaymentsProcessor(invoice)

      expect(paymentsProcessor.getInvoice).to.have.been.calledOnceWithExactly('inv1')
    })

    it('re-throws errors', async () => {
      paymentsProcessor.getInvoice.rejects(new Error('api error'))

      await expect(
        service.getInvoiceFromPaymentsProcessor('inv1'),
      ).to.be.rejectedWith('api error')
    })
  })

  describe('createInvoice', () => {
    const pubkey = 'a'.repeat(64)
    const amount = 1000n
    const description = 'test invoice'

    beforeEach(() => {
      paymentsProcessor.createInvoice.resolves({
        id: 'new-inv-id',
        bolt11: 'lnbc1...',
        amountRequested: 1000n,
        description: 'test invoice',
        unit: InvoiceUnit.MSATS,
        status: InvoiceStatus.PENDING,
        expiresAt: new Date('2025-01-01'),
        createdAt: new Date('2024-12-01'),
        verifyURL: 'https://verify.test/inv1',
      })
    })

    it('calls transaction.begin, upserts user, creates invoice, upserts invoice, and commits', async () => {
      await service.createInvoice(pubkey, amount, description)

      expect(dbClient.transaction).to.have.been.calledOnce
      expect(userRepository.upsert).to.have.been.calledOnce
      expect(userRepository.upsert.firstCall.args[0]).to.deep.equal({ pubkey })
      expect(paymentsProcessor.createInvoice).to.have.been.calledOnce
      expect(invoiceRepository.upsert).to.have.been.calledOnce
      expect(transactionStub.commit).to.have.been.calledOnce
    })

    it('returns invoice with correct fields', async () => {
      const result = await service.createInvoice(pubkey, amount, description)

      expect(result.id).to.equal('new-inv-id')
      expect(result.pubkey).to.equal(pubkey)
      expect(result.bolt11).to.equal('lnbc1...')
      expect(result.amountRequested).to.equal(1000n)
      expect(result.unit).to.equal(InvoiceUnit.MSATS)
      expect(result.status).to.equal(InvoiceStatus.PENDING)
      expect(result.description).to.equal(description)
      expect(result.verifyURL).to.equal('https://verify.test/inv1')
    })

    it('rolls back transaction and re-throws on error', async () => {
      paymentsProcessor.createInvoice.rejects(new Error('processor error'))

      await expect(
        service.createInvoice(pubkey, amount, description),
      ).to.be.rejectedWith('processor error')

      expect(transactionStub.rollback).to.have.been.calledOnce
    })
  })

  describe('updateInvoice', () => {
    it('calls invoiceRepository.updateStatus with id and status', async () => {
      invoiceRepository.updateStatus.resolves()

      await service.updateInvoice({ id: 'inv1', status: InvoiceStatus.COMPLETED })

      expect(invoiceRepository.updateStatus).to.have.been.calledOnceWithExactly({
        id: 'inv1',
        status: InvoiceStatus.COMPLETED,
      })
    })

    it('re-throws on error', async () => {
      invoiceRepository.updateStatus.rejects(new Error('update error'))

      await expect(
        service.updateInvoice({ id: 'inv1', status: InvoiceStatus.COMPLETED }),
      ).to.be.rejectedWith('update error')
    })
  })

  describe('updateInvoiceStatus', () => {
    it('calls invoiceRepository.updateStatus and returns result', async () => {
      const expected = { id: 'inv1', status: InvoiceStatus.COMPLETED } as Invoice
      invoiceRepository.updateStatus.resolves(expected)

      const result = await service.updateInvoiceStatus({ id: 'inv1', status: InvoiceStatus.COMPLETED })

      expect(result).to.deep.equal(expected)
    })

    it('re-throws on error', async () => {
      invoiceRepository.updateStatus.rejects(new Error('status error'))

      await expect(
        service.updateInvoiceStatus({ id: 'inv1', status: InvoiceStatus.COMPLETED }),
      ).to.be.rejectedWith('status error')
    })
  })

  describe('confirmInvoice', () => {
    const baseInvoice: Invoice = {
      id: 'inv1',
      pubkey: 'a'.repeat(64),
      bolt11: 'lnbc1...',
      amountRequested: 5000n,
      amountPaid: 5000n,
      unit: InvoiceUnit.MSATS,
      status: InvoiceStatus.COMPLETED,
      description: 'test',
      confirmedAt: new Date('2024-12-01'),
      expiresAt: new Date('2025-01-01'),
      updatedAt: new Date('2024-12-01'),
      createdAt: new Date('2024-12-01'),
    }

    it('rejects when confirmedAt is not set', async () => {
      const invoice = { ...baseInvoice, confirmedAt: undefined }

      await expect(service.confirmInvoice(invoice)).to.be.rejected
    })

    it('rejects when status is not COMPLETED', async () => {
      const invoice = { ...baseInvoice, status: InvoiceStatus.PENDING }

      await expect(service.confirmInvoice(invoice)).to.be.rejected
    })

    it('rejects when amountPaid is not bigint', async () => {
      const invoice = { ...baseInvoice, amountPaid: undefined }

      await expect(service.confirmInvoice(invoice as any)).to.be.rejected
    })

    it('confirms invoice and commits transaction', async () => {
      await service.confirmInvoice(baseInvoice)

      expect(invoiceRepository.confirmInvoice).to.have.been.calledOnce
      expect(transactionStub.commit).to.have.been.calledOnce
    })

    it('converts SATS to MSATS by multiplying by 1000', async () => {
      const feeSchedule: FeeSchedule = {
        enabled: true,
        amount: 5000000n, // 5_000_000 msats
      }
      settingsFn.returns({
        info: { relay_url: 'wss://relay.test' },
        payments: {
          enabled: true,
          processor: 'lnbits',
          feeSchedules: {
            admission: [feeSchedule],
            publication: [],
          },
        },
      })

      const invoice = { ...baseInvoice, unit: InvoiceUnit.SATS, amountPaid: 5000n }
      // 5000 SATS * 1000 = 5_000_000 MSATS >= 5_000_000 fee -> should admit
      await service.confirmInvoice(invoice)

      expect(userRepository.upsert).to.have.been.calledOnce
      expect(userRepository.upsert.firstCall.args[0].isAdmitted).to.be.true
    })

    it('converts BTC to MSATS by multiplying by 1000 * 100_000_000', async () => {
      const feeSchedule: FeeSchedule = {
        enabled: true,
        amount: 100000000000n, // 100_000_000_000 msats = 1 BTC
      }
      settingsFn.returns({
        info: { relay_url: 'wss://relay.test' },
        payments: {
          enabled: true,
          processor: 'lnbits',
          feeSchedules: {
            admission: [feeSchedule],
            publication: [],
          },
        },
      })

      const invoice = { ...baseInvoice, unit: InvoiceUnit.BTC, amountPaid: 1n }
      // 1 BTC * 1000 * 100_000_000 = 100_000_000_000 MSATS >= fee -> should admit
      await service.confirmInvoice(invoice)

      expect(userRepository.upsert).to.have.been.calledOnce
      expect(userRepository.upsert.firstCall.args[0].isAdmitted).to.be.true
    })

    it('does not admit user when fee amount is 0', async () => {
      settingsFn.returns({
        info: { relay_url: 'wss://relay.test' },
        payments: {
          enabled: true,
          processor: 'lnbits',
          feeSchedules: {
            admission: [],
            publication: [],
          },
        },
      })

      await service.confirmInvoice(baseInvoice)

      expect(userRepository.upsert).not.to.have.been.called
    })

    it('does not admit user when payment is insufficient', async () => {
      const feeSchedule: FeeSchedule = {
        enabled: true,
        amount: 10000n,
      }
      settingsFn.returns({
        info: { relay_url: 'wss://relay.test' },
        payments: {
          enabled: true,
          processor: 'lnbits',
          feeSchedules: {
            admission: [feeSchedule],
            publication: [],
          },
        },
      })

      const invoice = { ...baseInvoice, amountPaid: 5000n }
      // 5000 MSATS < 10000 fee -> should NOT admit
      await service.confirmInvoice(invoice)

      expect(userRepository.upsert).not.to.have.been.called
    })

    it('skips fee schedules where pubkey is whitelisted', async () => {
      const feeSchedule: FeeSchedule = {
        enabled: true,
        amount: 10000n,
        whitelists: {
          pubkeys: ['a'.repeat(64)],
        },
      }
      settingsFn.returns({
        info: { relay_url: 'wss://relay.test' },
        payments: {
          enabled: true,
          processor: 'lnbits',
          feeSchedules: {
            admission: [feeSchedule],
            publication: [],
          },
        },
      })

      // pubkey starts with 'a' which matches the whitelist prefix
      await service.confirmInvoice(baseInvoice)

      // Fee is 0 because the only schedule is whitelisted
      expect(userRepository.upsert).not.to.have.been.called
    })

    it('sums fees from multiple enabled admission schedules', async () => {
      const feeSchedules: FeeSchedule[] = [
        { enabled: true, amount: 2000n },
        { enabled: true, amount: 3000n },
        { enabled: false, amount: 99999n },
      ]
      settingsFn.returns({
        info: { relay_url: 'wss://relay.test' },
        payments: {
          enabled: true,
          processor: 'lnbits',
          feeSchedules: {
            admission: feeSchedules,
            publication: [],
          },
        },
      })

      // amountPaid: 5000 MSATS >= 2000+3000 = 5000 fee -> should admit
      await service.confirmInvoice(baseInvoice)

      expect(userRepository.upsert).to.have.been.calledOnce
      expect(userRepository.upsert.firstCall.args[0].isAdmitted).to.be.true
    })

    it('rolls back transaction on error', async () => {
      invoiceRepository.confirmInvoice.rejects(new Error('confirm error'))

      await expect(
        service.confirmInvoice(baseInvoice),
      ).to.be.rejectedWith('confirm error')

      expect(transactionStub.rollback).to.have.been.calledOnce
    })
  })

  describe('sendInvoiceUpdateNotification', () => {
    const baseInvoice: Invoice = {
      id: 'inv1',
      pubkey: 'b'.repeat(64),
      bolt11: 'lnbc1...',
      amountRequested: 5000n,
      amountPaid: 5000n,
      unit: InvoiceUnit.MSATS,
      status: InvoiceStatus.COMPLETED,
      description: 'test',
      confirmedAt: new Date('2024-12-01'),
      expiresAt: new Date('2025-01-01'),
      updatedAt: new Date('2024-12-01'),
      createdAt: new Date('2024-12-01'),
    }

    it('throws when amountPaid is undefined', async () => {
      const invoice = { ...baseInvoice, amountPaid: undefined }

      await expect(
        service.sendInvoiceUpdateNotification(invoice as any),
      ).to.be.rejectedWith('Unable to notify user')
    })

    it('converts MSATS to SATS in event content', async () => {
      const invoice = { ...baseInvoice, unit: InvoiceUnit.MSATS, amountPaid: 5000n }
      // 5000 msats / 1000 = 5 sats

      await service.sendInvoiceUpdateNotification(invoice)

      expect(eventRepository.create).to.have.been.calledOnce
      const event = eventRepository.create.firstCall.args[0]
      expect(event.content).to.equal('Invoice paid: 5 sats')
    })

    it('keeps SATS unit as-is in event content', async () => {
      const invoice = { ...baseInvoice, unit: InvoiceUnit.SATS, amountPaid: 100n }

      await service.sendInvoiceUpdateNotification(invoice)

      expect(eventRepository.create).to.have.been.calledOnce
      const event = eventRepository.create.firstCall.args[0]
      expect(event.content).to.equal('Invoice paid: 100 sats')
    })

    it('constructs event with correct kind and tags', async () => {
      await service.sendInvoiceUpdateNotification(baseInvoice)

      expect(eventRepository.create).to.have.been.calledOnce
      const event = eventRepository.create.firstCall.args[0]
      expect(event.kind).to.equal(EventKinds.INVOICE_UPDATE)
      const tagNames = event.tags.map((t: string[]) => t[0])
      expect(tagNames).to.include(EventTags.Pubkey)
      expect(tagNames).to.include(EventTags.Invoice)
      expect(tagNames).to.include(EventTags.Expiration)
    })

    it('does not throw when pipeline fails, logs error instead', async () => {
      eventRepository.create.rejects(new Error('persist error'))
      const consoleErrorStub = sandbox.stub(console, 'error')

      // Should not throw
      await service.sendInvoiceUpdateNotification(baseInvoice)

      expect(consoleErrorStub).to.have.been.called
    })
  })
})
