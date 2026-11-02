import chai from 'chai'
import chaiAsPromised from 'chai-as-promised'
import sinon from 'sinon'
import sinonChai from 'sinon-chai'

import { InvoiceStatus, InvoiceUnit } from '../../../src/@types/invoice'
import { OpenNodePaymentsProcessor } from '../../../src/payments-processors/opennode-payments-processor'

chai.use(sinonChai)
chai.use(chaiAsPromised)

const { expect } = chai

const PUBKEY = 'b'.repeat(64)
const EXPIRES_AT_SECONDS = 1893456000 // 2030-01-01T00:00:00Z

const charge = (overrides: any = {}) => ({
  id: 'opennode-charge-id',
  order_id: PUBKEY,
  amount: 21,
  description: 'Admission fee',
  status: 'unpaid',
  lightning_invoice: { payreq: 'lnbc210n1opennode', expires_at: EXPIRES_AT_SECONDS },
  created_at: 1893455000,
  ...overrides,
})

describe('OpenNodePaymentsProcessor', () => {
  const settings = () =>
    ({ paymentsProcessors: { opennode: { callbackBaseURL: 'https://relay.example.com/callbacks/opennode' } } }) as any

  const makeProcessor = (httpClient: any, currentSettings: () => any = settings) =>
    new OpenNodePaymentsProcessor(httpClient, currentSettings)

  describe('createInvoice', () => {
    it('posts the charge in sats with the pubkey as order id, the callback url and a ten minute ttl', async () => {
      const httpClient = { post: sinon.stub().resolves({ data: { data: charge() } }) }

      await makeProcessor(httpClient).createInvoice({ amount: 21000n, description: 'Admission fee', requestId: PUBKEY })

      expect(httpClient.post).to.have.been.calledOnceWithExactly(
        '/v1/charges',
        {
          amount: 21,
          description: 'Admission fee',
          order_id: PUBKEY,
          callback_url: 'https://relay.example.com/callbacks/opennode',
          ttl: 10,
        },
        { maxRedirects: 1 },
      )
    })

    it('converts msats to whole sats, dropping any remainder', async () => {
      const httpClient = { post: sinon.stub().resolves({ data: { data: charge() } }) }

      await makeProcessor(httpClient).createInvoice({ amount: 21999n, description: 'd', requestId: PUBKEY })

      expect(httpClient.post.firstCall.args[1].amount).to.equal(21)
    })

    it('maps the charge to an invoice in sats', async () => {
      const httpClient = { post: sinon.stub().resolves({ data: { data: charge() } }) }

      const invoice = await makeProcessor(httpClient).createInvoice({
        amount: 21000n,
        description: 'Admission fee',
        requestId: PUBKEY,
      })

      expect(invoice.id).to.equal('opennode-charge-id')
      expect(invoice.pubkey).to.equal(PUBKEY)
      expect(invoice.bolt11).to.equal('lnbc210n1opennode')
      expect(invoice.amountRequested).to.equal(21n)
      expect(invoice.unit).to.equal(InvoiceUnit.SATS)
      expect(invoice.status).to.equal(InvoiceStatus.PENDING)
      expect(invoice.expiresAt).to.deep.equal(new Date(EXPIRES_AT_SECONDS * 1000))
      expect(invoice.createdAt).to.deep.equal(new Date(1893455000 * 1000))
      expect(invoice.confirmedAt).to.equal(null)
    })

    it('rethrows when the provider is unavailable, so no invoice is recorded', async () => {
      const httpClient = { post: sinon.stub().rejects(new Error('502 bad gateway')) }

      await expect(
        makeProcessor(httpClient).createInvoice({ amount: 21000n, description: 'd', requestId: PUBKEY }),
      ).to.be.rejectedWith('502 bad gateway')
    })

    it('fails when the provider answers without charge data', async () => {
      const httpClient = { post: sinon.stub().resolves({ data: {} }) }

      await expect(makeProcessor(httpClient).createInvoice({ amount: 21000n, description: 'd', requestId: PUBKEY })).to
        .be.rejected
    })
  })

  describe('getInvoice', () => {
    it('reads the charge by id', async () => {
      const httpClient = { get: sinon.stub().resolves({ data: { data: charge() } }) }

      await makeProcessor(httpClient).getInvoice('opennode-charge-id')

      expect(httpClient.get).to.have.been.calledOnceWithExactly('/v2/charge/opennode-charge-id', { maxRedirects: 1 })
    })

    const statuses: Array<[string, InvoiceStatus]> = [
      ['unpaid', InvoiceStatus.PENDING],
      ['processing', InvoiceStatus.PENDING],
      ['underpaid', InvoiceStatus.PENDING],
      ['paid', InvoiceStatus.COMPLETED],
      ['expired', InvoiceStatus.EXPIRED],
      ['refunded', InvoiceStatus.EXPIRED],
    ]
    for (const [providerStatus, status] of statuses) {
      it(`reports a ${providerStatus} charge as ${status}`, async () => {
        const httpClient = { get: sinon.stub().resolves({ data: { data: charge({ status: providerStatus }) } }) }

        expect((await makeProcessor(httpClient).getInvoice('opennode-charge-id')).status).to.equal(status)
      })
    }

    it('treats a status it does not know as undefined rather than as paid', async () => {
      const httpClient = { get: sinon.stub().resolves({ data: { data: charge({ status: 'something-new' }) } }) }

      const invoice = await makeProcessor(httpClient).getInvoice('opennode-charge-id')

      expect(invoice.status).to.not.equal(InvoiceStatus.COMPLETED)
    })

    it('stamps a paid charge as confirmed now, and leaves others unconfirmed', async () => {
      const paid = { get: sinon.stub().resolves({ data: { data: charge({ status: 'paid' }) } }) }
      const unpaid = { get: sinon.stub().resolves({ data: { data: charge() } }) }

      const before = Date.now()
      const paidInvoice = await makeProcessor(paid).getInvoice('opennode-charge-id')

      expect(paidInvoice.confirmedAt!.getTime()).to.be.within(before, Date.now())
      expect((await makeProcessor(unpaid).getInvoice('opennode-charge-id')).confirmedAt).to.equal(null)
    })

    it('reads the invoice from the lightning object when the charge has no lightning_invoice', async () => {
      const httpClient = {
        get: sinon.stub().resolves({
          data: {
            data: charge({
              lightning_invoice: undefined,
              lightning: { payreq: 'lnbc210n1fallback', expires_at: '2030-01-01T00:00:00.000Z' },
            }),
          },
        }),
      }

      const invoice = await makeProcessor(httpClient).getInvoice('opennode-charge-id')

      expect(invoice.bolt11).to.equal('lnbc210n1fallback')
      expect(invoice.expiresAt).to.deep.equal(new Date('2030-01-01T00:00:00.000Z'))
    })

    it('uses the price when the charge has no amount', async () => {
      const httpClient = { get: sinon.stub().resolves({ data: { data: charge({ amount: undefined, price: 42 }) } }) }

      expect((await makeProcessor(httpClient).getInvoice('opennode-charge-id')).amountRequested).to.equal(42n)
    })

    it('reads a created_at that is already a date string', async () => {
      const httpClient = {
        get: sinon.stub().resolves({ data: { data: charge({ created_at: '2029-12-31T23:50:00.000Z' }) } }),
      }

      expect((await makeProcessor(httpClient).getInvoice('opennode-charge-id')).createdAt).to.deep.equal(
        new Date('2029-12-31T23:50:00.000Z'),
      )
    })

    it('rethrows when the provider is unavailable', async () => {
      const httpClient = { get: sinon.stub().rejects(new Error('ETIMEDOUT')) }

      await expect(makeProcessor(httpClient).getInvoice('opennode-charge-id')).to.be.rejectedWith('ETIMEDOUT')
    })
  })
})
