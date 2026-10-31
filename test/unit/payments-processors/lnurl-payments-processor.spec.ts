import chai from 'chai'
import chaiAsPromised from 'chai-as-promised'
import sinon from 'sinon'
import sinonChai from 'sinon-chai'

import { InvoiceStatus, InvoiceUnit, LnurlInvoice } from '../../../src/@types/invoice'
import { LnurlPaymentsProcessor } from '../../../src/payments-processors/lnurl-payments-processor'

chai.use(sinonChai)
chai.use(chaiAsPromised)

const { expect } = chai

const PUBKEY = 'd'.repeat(64)

describe('LnurlPaymentsProcessor', () => {
  const settings = () =>
    ({ paymentsProcessors: { lnurl: { invoiceURL: 'https://pay.example.com/lnurlp/relay' } } }) as any

  const makeProcessor = (httpClient: any, currentSettings: () => any = settings) =>
    new LnurlPaymentsProcessor(httpClient, currentSettings)

  describe('createInvoice', () => {
    const callbackResponse = {
      data: { pr: 'lnbc210n1lnurl', verify: 'https://pay.example.com/verify/abc' },
    }

    it('asks the callback of the configured pay url for an invoice of the amount in msats', async () => {
      const httpClient = { get: sinon.stub().resolves(callbackResponse) }

      await makeProcessor(httpClient).createInvoice({ amount: 21000n, description: 'Admission', requestId: PUBKEY })

      expect(httpClient.get).to.have.been.calledOnceWithExactly(
        'https://pay.example.com/lnurlp/relay/callback?amount=21000&comment=Admission',
      )
    })

    it('maps the callback response to a pending invoice in msats with its verify url', async () => {
      const httpClient = { get: sinon.stub().resolves(callbackResponse) }
      const before = Date.now()

      const invoice = await makeProcessor(httpClient).createInvoice({
        amount: 21000n,
        description: 'Admission',
        requestId: PUBKEY,
      })

      expect(invoice.id).to.match(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
      expect(invoice.pubkey).to.equal(PUBKEY)
      expect(invoice.bolt11).to.equal('lnbc210n1lnurl')
      expect(invoice.amountRequested).to.equal(21000n)
      expect(invoice.description).to.equal('Admission')
      expect(invoice.unit).to.equal(InvoiceUnit.MSATS)
      expect(invoice.status).to.equal(InvoiceStatus.PENDING)
      expect(invoice.verifyURL).to.equal('https://pay.example.com/verify/abc')
      expect(invoice.expiresAt).to.equal(null)
      expect(invoice.confirmedAt).to.equal(null)
      expect(invoice.createdAt.getTime()).to.be.within(before, Date.now())
    })

    it('gives every invoice its own id, since the provider does not', async () => {
      const httpClient = { get: sinon.stub().resolves(callbackResponse) }
      const processor = makeProcessor(httpClient)

      const first = await processor.createInvoice({ amount: 1000n, description: 'd', requestId: PUBKEY })
      const second = await processor.createInvoice({ amount: 1000n, description: 'd', requestId: PUBKEY })

      expect(first.id).to.not.equal(second.id)
    })

    it('rethrows when the provider is unavailable, so no invoice is recorded', async () => {
      const httpClient = { get: sinon.stub().rejects(new Error('503 service unavailable')) }

      await expect(
        makeProcessor(httpClient).createInvoice({ amount: 21000n, description: 'd', requestId: PUBKEY }),
      ).to.be.rejectedWith('503 service unavailable')
    })
  })

  describe('getInvoice', () => {
    const lnurlInvoice = { id: 'invoice-id', verifyURL: 'https://pay.example.com/verify/abc' } as LnurlInvoice

    it('asks the verify url of the invoice whether it was paid', async () => {
      const httpClient = { get: sinon.stub().resolves({ data: { settled: false } }) }

      await makeProcessor(httpClient).getInvoice(lnurlInvoice)

      expect(httpClient.get).to.have.been.calledOnceWithExactly('https://pay.example.com/verify/abc')
    })

    it('reports a settled invoice as completed, confirmed now', async () => {
      const httpClient = { get: sinon.stub().resolves({ data: { settled: true } }) }
      const before = Date.now()

      const result = await makeProcessor(httpClient).getInvoice(lnurlInvoice)

      expect(result.id).to.equal('invoice-id')
      expect(result.status).to.equal(InvoiceStatus.COMPLETED)
      expect(result.confirmedAt!.getTime()).to.be.within(before, Date.now())
    })

    it('reports an unsettled invoice as pending and unconfirmed', async () => {
      const httpClient = { get: sinon.stub().resolves({ data: { settled: false } }) }

      const result = await makeProcessor(httpClient).getInvoice(lnurlInvoice)

      expect(result.status).to.equal(InvoiceStatus.PENDING)
      expect(result.confirmedAt).to.equal(undefined)
    })

    it('does not report an invoice as paid when the answer has no settled field', async () => {
      const httpClient = { get: sinon.stub().resolves({ data: {} }) }

      expect((await makeProcessor(httpClient).getInvoice(lnurlInvoice)).status).to.equal(InvoiceStatus.PENDING)
    })

    it('rethrows when the provider is unavailable', async () => {
      const httpClient = { get: sinon.stub().rejects(new Error('ETIMEDOUT')) }

      await expect(makeProcessor(httpClient).getInvoice(lnurlInvoice)).to.be.rejectedWith('ETIMEDOUT')
    })
  })
})
