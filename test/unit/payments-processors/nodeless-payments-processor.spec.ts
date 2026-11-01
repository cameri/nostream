import chai from 'chai'
import chaiAsPromised from 'chai-as-promised'
import sinon from 'sinon'
import sinonChai from 'sinon-chai'

import { InvoiceStatus } from '../../../src/@types/invoice'
import { NodelessPaymentsProcessor } from '../../../src/payments-processors/nodeless-payments-processor'

chai.use(sinonChai)
chai.use(chaiAsPromised)

const { expect } = chai

const PUBKEY = 'c'.repeat(64)

const invoice = (overrides: any = {}) => ({
  id: 'nodeless-invoice-id',
  status: 'new',
  satsAmount: 21,
  lightningInvoice: 'lnbc210n1nodeless',
  metadata: { requestId: PUBKEY, description: 'Admission fee', unit: 'sats' },
  createdAt: '2029-12-31T23:50:00.000Z',
  expiresAt: '2030-01-01T00:00:00.000Z',
  paidAt: null,
  ...overrides,
})

describe('NodelessPaymentsProcessor', () => {
  const settings = () => ({ paymentsProcessors: { nodeless: { storeId: 'store-123' } } }) as any

  const makeProcessor = (httpClient: any) => new NodelessPaymentsProcessor(httpClient, settings)

  describe('createInvoice', () => {
    it('posts the invoice to the store in sats, with the pubkey and description as metadata', async () => {
      const httpClient = { post: sinon.stub().resolves({ data: { data: invoice() }, headers: {} }) }
      const before = Date.now()

      await makeProcessor(httpClient).createInvoice({ amount: 21000n, description: 'Admission fee', requestId: PUBKEY })

      expect(httpClient.post).to.have.been.calledOnce
      const [url, body, options] = httpClient.post.firstCall.args
      expect(url).to.equal('/api/v1/store/store-123/invoice')
      expect(options).to.deep.equal({ maxRedirects: 1 })
      expect(body).to.include({ amount: 21, currency: 'SATS' })
      expect(body.metadata).to.include({ description: 'Admission fee', requestId: PUBKEY, unit: 'sats' })
      expect(new Date(body.metadata.createdAt).getTime()).to.be.within(before, Date.now())
    })

    it('converts msats to whole sats, dropping any remainder', async () => {
      const httpClient = { post: sinon.stub().resolves({ data: { data: invoice() }, headers: {} }) }

      await makeProcessor(httpClient).createInvoice({ amount: 21999n, description: 'd', requestId: PUBKEY })

      expect(httpClient.post.firstCall.args[1].amount).to.equal(21)
    })

    it('maps the response to an invoice in sats', async () => {
      const httpClient = { post: sinon.stub().resolves({ data: { data: invoice() }, headers: {} }) }

      const result = await makeProcessor(httpClient).createInvoice({
        amount: 21000n,
        description: 'Admission fee',
        requestId: PUBKEY,
      })

      expect(result.id).to.equal('nodeless-invoice-id')
      expect(result.pubkey).to.equal(PUBKEY)
      expect(result.bolt11).to.equal('lnbc210n1nodeless')
      expect(result.amountRequested).to.equal(21n)
      expect(result.description).to.equal('Admission fee')
      expect(result.unit).to.equal('sats')
      expect(result.status).to.equal(InvoiceStatus.PENDING)
      expect(result.expiresAt).to.deep.equal(new Date('2030-01-01T00:00:00.000Z'))
      expect(result.createdAt).to.deep.equal(new Date('2029-12-31T23:50:00.000Z'))
      expect(result.confirmedAt).to.equal(null)
    })

    it('expires an invoice fifteen minutes after it was created when the provider gives no expiry', async () => {
      const httpClient = {
        post: sinon.stub().resolves({ data: { data: invoice({ expiresAt: undefined }) }, headers: {} }),
      }

      const result = await makeProcessor(httpClient).createInvoice({
        amount: 21000n,
        description: 'd',
        requestId: PUBKEY,
      })

      expect(result.expiresAt).to.deep.equal(new Date('2030-01-01T00:05:00.000Z'))
    })

    it('rethrows when the provider is unavailable, so no invoice is recorded', async () => {
      const httpClient = { post: sinon.stub().rejects(new Error('503 service unavailable')) }

      await expect(
        makeProcessor(httpClient).createInvoice({ amount: 21000n, description: 'd', requestId: PUBKEY }),
      ).to.be.rejectedWith('503 service unavailable')
    })

    it('fails when the provider answers without invoice data', async () => {
      const httpClient = { post: sinon.stub().resolves({ data: {}, headers: {} }) }

      await expect(makeProcessor(httpClient).createInvoice({ amount: 21000n, description: 'd', requestId: PUBKEY })).to
        .be.rejected
    })
  })

  describe('getInvoice', () => {
    it('reads the invoice from the configured store', async () => {
      const httpClient = { get: sinon.stub().resolves({ data: { data: invoice() } }) }

      await makeProcessor(httpClient).getInvoice('nodeless-invoice-id')

      expect(httpClient.get).to.have.been.calledOnceWithExactly('/api/v1/store/store-123/invoice/nodeless-invoice-id', {
        maxRedirects: 1,
      })
    })

    const statuses: Array<[string, InvoiceStatus]> = [
      ['new', InvoiceStatus.PENDING],
      ['pending_confirmation', InvoiceStatus.PENDING],
      ['underpaid', InvoiceStatus.PENDING],
      ['in_flight', InvoiceStatus.PENDING],
      ['paid', InvoiceStatus.COMPLETED],
      ['overpaid', InvoiceStatus.COMPLETED],
      ['expired', InvoiceStatus.EXPIRED],
    ]
    for (const [providerStatus, status] of statuses) {
      it(`reports a ${providerStatus} invoice as ${status}`, async () => {
        const httpClient = { get: sinon.stub().resolves({ data: { data: invoice({ status: providerStatus }) } }) }

        expect((await makeProcessor(httpClient).getInvoice('nodeless-invoice-id')).status).to.equal(status)
      })
    }

    it('treats a status it does not know as undefined rather than as paid', async () => {
      const httpClient = { get: sinon.stub().resolves({ data: { data: invoice({ status: 'something-new' }) } }) }

      expect((await makeProcessor(httpClient).getInvoice('nodeless-invoice-id')).status).to.equal(undefined)
    })

    it('reports when a paid invoice was confirmed', async () => {
      const httpClient = {
        get: sinon.stub().resolves({ data: { data: invoice({ status: 'paid', paidAt: '2030-01-01T00:05:00.000Z' }) } }),
      }

      expect((await makeProcessor(httpClient).getInvoice('nodeless-invoice-id')).confirmedAt).to.deep.equal(
        new Date('2030-01-01T00:05:00.000Z'),
      )
    })

    it('rethrows when the provider is unavailable', async () => {
      const httpClient = { get: sinon.stub().rejects(new Error('ETIMEDOUT')) }

      await expect(makeProcessor(httpClient).getInvoice('nodeless-invoice-id')).to.be.rejectedWith('ETIMEDOUT')
    })
  })
})
