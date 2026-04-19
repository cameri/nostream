import * as chai from 'chai'
import * as sinon from 'sinon'
import knex from 'knex'
import sinonChai from 'sinon-chai'

import { DatabaseClient } from '../../../src/@types/base'
import { DBInvoice, Invoice, InvoiceStatus, InvoiceUnit } from '../../../src/@types/invoice'
import { IInvoiceRepository } from '../../../src/@types/repositories'
import { InvoiceRepository } from '../../../src/repositories/invoice-repository'

chai.use(sinonChai)
const { expect } = chai

const PUBKEY = '22e804d26ed16b68db5259e78449e96dab5d464c8f470bda3eb1a70467f2c793'

function makeInvoice(overrides: Partial<Invoice> = {}): Invoice {
  const now = new Date()
  return {
    id: 'test-invoice-id',
    pubkey: PUBKEY,
    bolt11: 'lnbctest',
    amountRequested: 1000n,
    unit: InvoiceUnit.MSATS,
    status: InvoiceStatus.PENDING,
    description: 'test invoice',
    expiresAt: null,
    updatedAt: now,
    createdAt: now,
    ...overrides,
  }
}

function makeDBInvoice(overrides: Partial<DBInvoice> = {}): DBInvoice {
  const now = new Date()
  return {
    id: 'test-invoice-id',
    pubkey: Buffer.from(PUBKEY, 'hex'),
    bolt11: 'lnbctest',
    amount_requested: 1000n,
    amount_paid: null as any,
    unit: InvoiceUnit.MSATS,
    status: InvoiceStatus.PENDING,
    description: 'test invoice',
    confirmed_at: null as any,
    expires_at: null as any,
    updated_at: now,
    created_at: now,
    verify_url: '',
    ...overrides,
  }
}

describe('InvoiceRepository', () => {
  let repository: IInvoiceRepository
  let sandbox: sinon.SinonSandbox
  let dbClient: DatabaseClient

  beforeEach(() => {
    sandbox = sinon.createSandbox()
    dbClient = knex({ client: 'pg' })
    repository = new InvoiceRepository(dbClient)
  })

  afterEach(() => {
    dbClient.destroy()
    sandbox.restore()
  })

  describe('.updateStatus', () => {
    it('returns a thenable with then, catch, and toString', () => {
      const result = repository.updateStatus(makeInvoice())

      expect(result).to.have.property('then')
      expect(result).to.have.property('catch')
      expect(result).to.have.property('toString')
    })

    it('toString generates UPDATE query targeting the invoice id', () => {
      const sql = repository.updateStatus(makeInvoice({ id: 'inv-123', status: InvoiceStatus.COMPLETED })).toString()

      expect(sql).to.include('"invoices"')
      expect(sql).to.include("'completed'")
      expect(sql).to.include("'inv-123'")
      expect(sql).to.include('returning')
    })
  })

  describe('.upsert', () => {
    it('returns a thenable with then, catch, and toString', () => {
      const result = repository.upsert(makeInvoice())

      expect(result).to.have.property('then')
      expect(result).to.have.property('catch')
      expect(result).to.have.property('toString')
    })

    it('uses the existing id when invoice has a string id', () => {
      const sql = repository.upsert(makeInvoice({ id: 'my-specific-id' })).toString()

      expect(sql).to.include("'my-specific-id'")
    })

    it('generates a UUID when invoice has no id', () => {
      const invoice = makeInvoice()
      delete (invoice as any).id

      const sql = repository.upsert(invoice).toString()

      expect(sql).to.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/)
    })

    it('toString contains INSERT … on conflict merge for "invoices"', () => {
      const sql = repository.upsert(makeInvoice()).toString()

      expect(sql).to.include('"invoices"')
      expect(sql).to.include('on conflict')
      expect(sql).to.include("'1000'")
    })
  })

  describe('.findById', () => {
    it('returns undefined when invoice not found', async () => {
      const mockSelect = sandbox.stub().resolves([])
      const mockWhere = sandbox.stub().returns({ select: mockSelect })
      const mockClient = sandbox.stub().returns({ where: mockWhere }) as unknown as DatabaseClient

      const repo = new InvoiceRepository(mockClient)
      const result = await repo.findById('nonexistent-id')

      expect(result).to.be.undefined
      expect(mockWhere).to.have.been.calledWith('id', 'nonexistent-id')
    })

    it('returns mapped Invoice when found', async () => {
      const dbRow = makeDBInvoice({ id: 'found-id', amount_requested: 2500n })
      const mockSelect = sandbox.stub().resolves([dbRow])
      const mockWhere = sandbox.stub().returns({ select: mockSelect })
      const mockClient = sandbox.stub().returns({ where: mockWhere }) as unknown as DatabaseClient

      const repo = new InvoiceRepository(mockClient)
      const result = await repo.findById('found-id')

      expect(result).to.not.be.undefined
      expect(result!.id).to.equal('found-id')
      expect(result!.pubkey).to.equal(PUBKEY)
      expect(result!.amountRequested).to.equal(2500n)
    })

    it('maps amountPaid when present', async () => {
      const dbRow = makeDBInvoice({ amount_paid: 999n })
      const mockSelect = sandbox.stub().resolves([dbRow])
      const mockWhere = sandbox.stub().returns({ select: mockSelect })
      const mockClient = sandbox.stub().returns({ where: mockWhere }) as unknown as DatabaseClient

      const repo = new InvoiceRepository(mockClient)
      const result = await repo.findById('test-invoice-id')

      expect(result!.amountPaid).to.equal(999n)
    })
  })

  describe('.findPendingInvoices', () => {
    it('returns mapped invoices with default offset=0 and limit=10', async () => {
      const dbRow = makeDBInvoice({ id: 'pending-id' })
      const mockSelect = sandbox.stub().resolves([dbRow])
      const mockLimit = sandbox.stub().returns({ select: mockSelect })
      const mockOffset = sandbox.stub().returns({ limit: mockLimit })
      const mockWhere = sandbox.stub().returns({ offset: mockOffset })
      const mockClient = sandbox.stub().returns({ where: mockWhere }) as unknown as DatabaseClient

      const repo = new InvoiceRepository(mockClient)
      const results = await repo.findPendingInvoices()

      expect(results).to.have.length(1)
      expect(results[0].id).to.equal('pending-id')
      expect(mockWhere).to.have.been.calledWith('status', InvoiceStatus.PENDING)
      expect(mockOffset).to.have.been.calledWith(0)
      expect(mockLimit).to.have.been.calledWith(10)
    })

    it('forwards provided offset and limit', async () => {
      const mockSelect = sandbox.stub().resolves([])
      const mockLimit = sandbox.stub().returns({ select: mockSelect })
      const mockOffset = sandbox.stub().returns({ limit: mockLimit })
      const mockWhere = sandbox.stub().returns({ offset: mockOffset })
      const mockClient = sandbox.stub().returns({ where: mockWhere }) as unknown as DatabaseClient

      const repo = new InvoiceRepository(mockClient)
      await repo.findPendingInvoices(5, 20)

      expect(mockOffset).to.have.been.calledWith(5)
      expect(mockLimit).to.have.been.calledWith(20)
    })

    it('returns empty array when no pending invoices exist', async () => {
      const mockSelect = sandbox.stub().resolves([])
      const mockLimit = sandbox.stub().returns({ select: mockSelect })
      const mockOffset = sandbox.stub().returns({ limit: mockLimit })
      const mockWhere = sandbox.stub().returns({ offset: mockOffset })
      const mockClient = sandbox.stub().returns({ where: mockWhere }) as unknown as DatabaseClient

      const repo = new InvoiceRepository(mockClient)
      const results = await repo.findPendingInvoices()

      expect(results).to.deep.equal([])
    })
  })

  describe('.confirmInvoice', () => {
    it('calls client.raw with invoice id, stringified amount, and ISO date', async () => {
      const rawStub = sandbox.stub().resolves()
      const mockClient = { raw: rawStub } as unknown as DatabaseClient

      const invoiceId = 'confirm-me'
      const amount = 5000n
      const confirmedAt = new Date('2024-01-15T10:00:00.000Z')

      const repo = new InvoiceRepository(mockClient)
      await repo.confirmInvoice(invoiceId, amount, confirmedAt)

      expect(rawStub).to.have.been.calledOnceWithExactly('select confirm_invoice(?, ?, ?)', [
        invoiceId,
        '5000',
        confirmedAt.toISOString(),
      ])
    })

    it('uses the injected client parameter over the default', async () => {
      const defaultRaw = sandbox.stub().resolves()
      const injectedRaw = sandbox.stub().resolves()
      const defaultClient = { raw: defaultRaw } as unknown as DatabaseClient
      const injectedClient = { raw: injectedRaw } as unknown as DatabaseClient

      const repo = new InvoiceRepository(defaultClient)
      await repo.confirmInvoice('id', 100n, new Date(), injectedClient)

      expect(defaultRaw).to.not.have.been.called
      expect(injectedRaw).to.have.been.calledOnce
    })

    it('re-throws when client.raw rejects', async () => {
      const err = new Error('DB unavailable')
      const rawStub = sandbox.stub().rejects(err)
      const mockClient = { raw: rawStub } as unknown as DatabaseClient

      const repo = new InvoiceRepository(mockClient)
      let thrown: Error | undefined

      try {
        await repo.confirmInvoice('id', 100n, new Date())
      } catch (e) {
        thrown = e as Error
      }

      expect(thrown).to.not.be.undefined
      expect(thrown!.message).to.equal('DB unavailable')
    })
  })
})
