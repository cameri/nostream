import chai from 'chai'
import sinon from 'sinon'
import sinonChai from 'sinon-chai'

import { PaymentsProcessorOutcomeUnknownError } from '../../../src/@types/clients'
import { InvoiceStatus, InvoiceUnit } from '../../../src/@types/invoice'
import { LNbitsPaymentsProcessor } from '../../../src/payments-processors/lnbits-payment-processor'

chai.use(sinonChai)

const { expect } = chai

const invoiceResponse = (overrides: any = {}) => ({
  data: {
    paid: false,
    details: {
      payment_hash: 'lnbits-payment-hash',
      extra: {
        internalId: 'a'.repeat(64),
      },
      bolt11: 'lnbc1test',
      amount: 42000,
      memo: 'LNbits test invoice',
      time: Math.floor(Date.now() / 1000),
      expiry: Math.floor((Date.now() + 600000) / 1000),
      ...overrides.details,
    },
    ...overrides.data,
  },
})

describe('LNbitsPaymentsProcessor', () => {
  const makeProcessor = (response: any) => {
    const httpClient = {
      get: sinon.stub().resolves(response),
    }

    return {
      processor: new LNbitsPaymentsProcessor(httpClient as any, (() => ({})) as any),
      httpClient,
    }
  }

  describe('getInvoice', () => {
    it('returns PENDING for unpaid invoices that have not expired', async () => {
      const { processor } = makeProcessor(invoiceResponse())

      const invoice = await processor.getInvoice('lnbits-payment-hash')

      expect(invoice.status).to.equal(InvoiceStatus.PENDING)
      expect(invoice.unit).to.equal(InvoiceUnit.SATS)
    })

    it('returns EXPIRED for unpaid invoices past their LNbits expiry time', async () => {
      const { processor } = makeProcessor(
        invoiceResponse({
          details: {
            expiry: Math.floor((Date.now() - 60000) / 1000),
          },
        }),
      )

      const invoice = await processor.getInvoice('lnbits-payment-hash')

      expect(invoice.status).to.equal(InvoiceStatus.EXPIRED)
    })

    it('keeps paid invoices COMPLETED even if the expiry time has passed', async () => {
      const { processor } = makeProcessor(
        invoiceResponse({
          data: {
            paid: true,
          },
          details: {
            expiry: Math.floor((Date.now() - 60000) / 1000),
          },
        }),
      )

      const invoice = await processor.getInvoice('lnbits-payment-hash')

      expect(invoice.status).to.equal(InvoiceStatus.COMPLETED)
      expect(invoice.amountPaid).to.equal(42n)
    })

    it('parses ISO 8601 time and expiry returned by LNbits >= 1.0', async () => {
      const time = new Date(Date.now() - 120000)
      const expiry = new Date(Date.now() - 60000)
      const { processor } = makeProcessor(
        invoiceResponse({
          details: {
            time: time.toISOString(),
            expiry: expiry.toISOString(),
          },
        }),
      )

      const invoice = await processor.getInvoice('lnbits-payment-hash')

      expect(invoice.status).to.equal(InvoiceStatus.EXPIRED)
      expect(invoice.expiresAt?.getTime()).to.equal(expiry.getTime())
      expect(invoice.createdAt?.getTime()).to.equal(time.getTime())
    })

    it('keeps an outgoing payment pending after its bolt11 expires while the wallet is unsettled', async () => {
      const { processor } = makeProcessor(
        invoiceResponse({
          details: {
            expiry: Math.floor((Date.now() - 60000) / 1000),
            pending: true,
          },
        }),
      )

      const invoice = await processor.getInvoice('lnbits-payment-hash', 'outgoing')

      expect(invoice.status).to.equal(InvoiceStatus.PENDING)
    })

    it('reports a terminal outgoing failure as EXPIRED', async () => {
      const { processor } = makeProcessor(
        invoiceResponse({
          details: {
            expiry: Math.floor((Date.now() + 600000) / 1000),
            pending: false,
          },
        }),
      )

      const invoice = await processor.getInvoice('lnbits-payment-hash', 'outgoing')

      expect(invoice.status).to.equal(InvoiceStatus.EXPIRED)
    })

    it('sets a valid confirmedAt for paid invoices with an ISO 8601 time', async () => {
      const { processor } = makeProcessor(
        invoiceResponse({
          data: {
            paid: true,
          },
          details: {
            time: '2025-10-11T15:24:27+00:00',
            expiry: '2025-10-12T15:24:27+00:00',
          },
        }),
      )

      const invoice = await processor.getInvoice('lnbits-payment-hash')

      expect(invoice.status).to.equal(InvoiceStatus.COMPLETED)
      expect(invoice.confirmedAt?.toISOString()).to.equal('2025-10-11T15:24:27.000Z')
    })
  })

  describe('payInvoice', () => {
    it('sends an outgoing payment and returns the processor payment hash', async () => {
      const httpClient = {
        post: sinon.stub().resolves({ data: { payment_hash: 'paid-hash' } }),
      }
      const processor = new LNbitsPaymentsProcessor(httpClient as any, (() => ({})) as any)
      const bolt11 =
        'lnbc2500u1pvjluezsp5zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygspp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqdq5xysxxatsyp3k7enxv4jsxqzpu9qrsgquk0rl77nj30yxdy8j9vdx85fkpmdla2087ne0xh8nhedh8w27kyke0lp53ut353s06fv3qfegext0eh0ymjpf39tuven09sam30g4vgpfna3rh'

      const result = await processor.payInvoice({ bolt11 })

      expect(result.paymentHash).to.equal('paid-hash')
      expect(httpClient.post).to.have.been.calledWith('/api/v1/payments', { out: true, bolt11 }, { maxRedirects: 1 })
    })

    it('treats a dropped payment response as an unknown outcome', async () => {
      const error = Object.assign(new Error('socket hang up'), { isAxiosError: true })
      const httpClient = { post: sinon.stub().rejects(error) }
      const processor = new LNbitsPaymentsProcessor(httpClient as any, (() => ({})) as any)
      const bolt11 =
        'lnbc2500u1pvjluezsp5zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygspp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqdq5xysxxatsyp3k7enxv4jsxqzpu9qrsgquk0rl77nj30yxdy8j9vdx85fkpmdla2087ne0xh8nhedh8w27kyke0lp53ut353s06fv3qfegext0eh0ymjpf39tuven09sam30g4vgpfna3rh'

      const rejection = await processor.payInvoice({ bolt11 }).catch((error) => error)

      expect(rejection).to.be.instanceOf(PaymentsProcessorOutcomeUnknownError)
    })

    it('keeps a definite wallet rejection on the failure path', async () => {
      const error = Object.assign(new Error('bad request'), {
        isAxiosError: true,
        response: { status: 400 },
      })
      const httpClient = { post: sinon.stub().rejects(error) }
      const processor = new LNbitsPaymentsProcessor(httpClient as any, (() => ({})) as any)
      const bolt11 =
        'lnbc2500u1pvjluezsp5zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygspp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqdq5xysxxatsyp3k7enxv4jsxqzpu9qrsgquk0rl77nj30yxdy8j9vdx85fkpmdla2087ne0xh8nhedh8w27kyke0lp53ut353s06fv3qfegext0eh0ymjpf39tuven09sam30g4vgpfna3rh'

      expect(await processor.payInvoice({ bolt11 }).catch((rejection) => rejection)).to.equal(error)
    })
  })
})
