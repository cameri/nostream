import * as chai from 'chai'
import * as sinon from 'sinon'
import knex from 'knex'
import sinonChai from 'sinon-chai'
import chaiAsPromised from 'chai-as-promised'

import { DatabaseClient } from '../../../src/@types/base'
import { Invoice, InvoiceStatus, InvoiceUnit } from '../../../src/@types/invoice'
import { IInvoiceRepository } from '../../../src/@types/repositories'
import { InvoiceRepository } from '../../../src/repositories/invoice-repository'

chai.use(sinonChai)
chai.use(chaiAsPromised)

const { expect } = chai

describe('InvoiceRepository', () => {
  let repository: IInvoiceRepository
  let sandbox: sinon.SinonSandbox
  let dbClient: DatabaseClient

  const pubkeyHex = '22e804d26ed16b68db5259e78449e96dab5d464c8f470bda3eb1a70467f2c793'
  const fixedDate = new Date('2026-01-01T00:00:00.000Z')

  const testInvoice: Invoice = {
    id: 'test-invoice-id',
    pubkey: pubkeyHex,
    bolt11: 'lnbc10n1pjqtest',
    amountRequested: 1000n,
    unit: InvoiceUnit.MSATS,
    status: InvoiceStatus.PENDING,
    description: 'test invoice',
    expiresAt: fixedDate,
    updatedAt: fixedDate,
    createdAt: fixedDate,
    verifyURL: 'https://example.com/verify',
  }

  const dbInvoiceRow = {
    id: 'test-invoice-id',
    pubkey: Buffer.from(pubkeyHex, 'hex'),
    bolt11: 'lnbc10n1pjqtest',
    amount_requested: '1000',
    amount_paid: null,
    unit: InvoiceUnit.MSATS,
    status: InvoiceStatus.PENDING,
    description: 'test invoice',
    confirmed_at: null,
    expires_at: fixedDate,
    updated_at: fixedDate,
    created_at: fixedDate,
    verify_url: 'https://example.com/verify',
  }

  beforeEach(() => {
    sandbox = sinon.createSandbox()
    sandbox.useFakeTimers(fixedDate.getTime())
    dbClient = knex({ client: 'pg' })
    repository = new InvoiceRepository(dbClient)
  })

  afterEach(() => {
    dbClient.destroy()
    sandbox.restore()
  })

  describe('.confirmInvoice', () => {
    it('calls raw with confirm_invoice stored procedure and correct arguments', async () => {
      const rawStub = sandbox.stub().resolves()
      const client = { raw: rawStub } as unknown as DatabaseClient

      await repository.confirmInvoice('invoice-123', 5000n, fixedDate, client)

      expect(rawStub).to.have.been.calledOnceWithExactly(
        'select confirm_invoice(?, ?, ?)',
        ['invoice-123', '5000', fixedDate.toISOString()],
      )
    })

    it('re-throws when raw call rejects', async () => {
      const dbError = new Error('connection refused')
      const client = { raw: sandbox.stub().rejects(dbError) } as unknown as DatabaseClient

      await expect(
        repository.confirmInvoice('invoice-123', 5000n, fixedDate, client),
      ).to.be.rejectedWith(dbError)
    })
  })

  describe('.findById', () => {
    it('returns undefined when no invoice is found', async () => {
      const selectStub = sandbox.stub().resolves([])
      const client = sandbox.stub().returns({
        where: sandbox.stub().returns({ select: selectStub }),
      }) as unknown as DatabaseClient

      const result = await repository.findById('nonexistent-id', client)

      expect(result).to.be.undefined
    })

    it('returns a transformed Invoice when found', async () => {
      const selectStub = sandbox.stub().resolves([dbInvoiceRow])
      const client = sandbox.stub().returns({
        where: sandbox.stub().returns({ select: selectStub }),
      }) as unknown as DatabaseClient

      const result = await repository.findById('test-invoice-id', client)

      expect(result).to.not.be.undefined
      expect(result!.id).to.equal('test-invoice-id')
      expect(result!.pubkey).to.equal(pubkeyHex)
      expect(result!.status).to.equal(InvoiceStatus.PENDING)
      expect(result!.amountRequested).to.equal(1000n)
    })

    it('queries invoices table by id', async () => {
      const whereStub = sandbox.stub().returns({ select: sandbox.stub().resolves([]) })
      const client = sandbox.stub().returns({ where: whereStub }) as unknown as DatabaseClient

      await repository.findById('some-id', client)

      expect(client).to.have.been.calledWith('invoices')
      expect(whereStub).to.have.been.calledWith('id', 'some-id')
    })
  })

  describe('.findPendingInvoices', () => {
    function makePendingClient(results: any[]): DatabaseClient {
      const selectStub = sandbox.stub().resolves(results)
      const limitStub = sandbox.stub().returns({ select: selectStub })
      const offsetStub = sandbox.stub().returns({ limit: limitStub })
      const orderByStub = sandbox.stub().returns({ offset: offsetStub })
      const whereStub = sandbox.stub().returns({ orderBy: orderByStub })
      return sandbox.stub().returns({ where: whereStub }) as unknown as DatabaseClient
    }

    it('returns empty array when no pending invoices exist', async () => {
      const result = await repository.findPendingInvoices(0, 10, makePendingClient([]))

      expect(result).to.deep.equal([])
    })

    it('returns transformed invoices when pending invoices are found', async () => {
      const result = await repository.findPendingInvoices(0, 10, makePendingClient([dbInvoiceRow]))

      expect(result).to.have.length(1)
      expect(result[0].id).to.equal('test-invoice-id')
      expect(result[0].amountRequested).to.equal(1000n)
    })

    it('passes offset and limit to the query', async () => {
      const selectStub = sandbox.stub().resolves([])
      const limitStub = sandbox.stub().returns({ select: selectStub })
      const offsetStub = sandbox.stub().returns({ limit: limitStub })
      const orderByStub = sandbox.stub().returns({ offset: offsetStub })
      const whereStub = sandbox.stub().returns({ orderBy: orderByStub })
      const client = sandbox.stub().returns({ where: whereStub }) as unknown as DatabaseClient

      await repository.findPendingInvoices(5, 20, client)

      expect(offsetStub).to.have.been.calledWith(5)
      expect(limitStub).to.have.been.calledWith(20)
    })

    it('orders by created_at ascending', async () => {
      const selectStub = sandbox.stub().resolves([])
      const limitStub = sandbox.stub().returns({ select: selectStub })
      const offsetStub = sandbox.stub().returns({ limit: limitStub })
      const orderByStub = sandbox.stub().returns({ offset: offsetStub })
      const whereStub = sandbox.stub().returns({ orderBy: orderByStub })
      const client = sandbox.stub().returns({ where: whereStub }) as unknown as DatabaseClient

      await repository.findPendingInvoices(0, 10, client)

      expect(orderByStub).to.have.been.calledWith('created_at', 'asc')
    })

    it('filters by pending status', async () => {
      const orderByStub = sandbox.stub().returns({
        offset: sandbox.stub().returns({ limit: sandbox.stub().returns({ select: sandbox.stub().resolves([]) }) }),
      })
      const whereStub = sandbox.stub().returns({ orderBy: orderByStub })
      const client = sandbox.stub().returns({ where: whereStub }) as unknown as DatabaseClient

      await repository.findPendingInvoices(0, 10, client)

      expect(whereStub).to.have.been.calledWith('status', InvoiceStatus.PENDING)
    })
  })

  describe('.updateStatus', () => {
    it('returns an object with then, catch, and toString', () => {
      const result = repository.updateStatus(testInvoice)

      expect(result).to.have.property('then').that.is.a('function')
      expect(result).to.have.property('catch').that.is.a('function')
      expect(result).to.have.property('toString').that.is.a('function')
    })

    it('generates UPDATE SQL targeting the invoices table', () => {
      const sql = repository.updateStatus(testInvoice).toString()

      expect(sql).to.include('update "invoices"')
      expect(sql).to.include('"status"')
      expect(sql).to.include('"updated_at"')
    })

    it('includes the invoice id in the WHERE clause', () => {
      const sql = repository.updateStatus(testInvoice).toString()

      expect(sql).to.include('"id"')
      expect(sql).to.include('test-invoice-id')
    })

    it('includes RETURNING * clause', () => {
      const sql = repository.updateStatus(testInvoice).toString()

      expect(sql).to.include('returning')
    })
  })

  describe('.upsert', () => {
    it('returns an object with then, catch, and toString', () => {
      const result = repository.upsert(testInvoice)

      expect(result).to.have.property('then').that.is.a('function')
      expect(result).to.have.property('catch').that.is.a('function')
      expect(result).to.have.property('toString').that.is.a('function')
    })

    it('generates INSERT with on-conflict do update set SQL', () => {
      const sql = repository.upsert(testInvoice).toString()

      expect(sql).to.include('insert into "invoices"')
      expect(sql).to.include('on conflict')
      expect(sql).to.include('do update set')
    })

    it('includes the invoice id when one is provided', () => {
      const sql = repository.upsert({ ...testInvoice, id: 'specific-id' }).toString()

      expect(sql).to.include('specific-id')
    })

    it('uses a generated UUID when no id is provided', () => {
      const { id: _id, ...invoiceWithoutId } = testInvoice
      const sql = repository.upsert(invoiceWithoutId as Invoice).toString()

      expect(sql).to.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/)
    })

    it('encodes pubkey as hex buffer in SQL', () => {
      const sql = repository.upsert(testInvoice).toString()

      expect(sql).to.include(`X'${pubkeyHex}'`)
    })

    it('includes all required invoice fields', () => {
      const sql = repository.upsert(testInvoice).toString()

      expect(sql).to.include('"bolt11"')
      expect(sql).to.include('"status"')
      expect(sql).to.include('"unit"')
      expect(sql).to.include('"description"')
    })
  })
})
