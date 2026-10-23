import chai from 'chai'
import sinon from 'sinon'
import sinonChai from 'sinon-chai'

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
})
