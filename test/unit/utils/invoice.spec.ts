import { expect } from 'chai'

import {
  DEFAULT_INVOICE_EXPIRY_SECONDS,
  isExpiredInvoice,
  MAX_INVOICE_EXPIRY_SECONDS,
  resolveInvoiceExpiry,
  resolveInvoiceExpirySeconds,
} from '../../../src/utils/invoice'

describe('invoice expiry', () => {
  const createdAt = new Date('2026-08-29T00:00:00.000Z')

  describe('isExpiredInvoice', () => {
    it('is true once the expiry has passed', () => {
      expect(isExpiredInvoice({ expiresAt: new Date('2020-01-01T00:00:00.000Z') })).to.equal(true)
    })

    it('is false for an expiry still in the future', () => {
      expect(isExpiredInvoice({ expiresAt: new Date('2999-01-01T00:00:00.000Z') })).to.equal(false)
    })

    it('is false when there is no expiry at all', () => {
      // This is why an invoice without an expiry can never be retired.
      expect(isExpiredInvoice({ expiresAt: null })).to.equal(false)
      expect(isExpiredInvoice({})).to.equal(false)
    })

    it('is false for a date that did not parse', () => {
      expect(isExpiredInvoice({ expiresAt: new Date('nonsense') })).to.equal(false)
    })
  })

  describe('resolveInvoiceExpirySeconds', () => {
    it('takes a positive whole number of seconds', () => {
      expect(resolveInvoiceExpirySeconds(3600)).to.equal(3600)
    })

    it('caps an over-long configured value', () => {
      // An over-long value leaves the row effectively never retired.
      expect(resolveInvoiceExpirySeconds(999999999)).to.equal(MAX_INVOICE_EXPIRY_SECONDS)
    })

    it('falls back on anything that is not one', () => {
      for (const bad of [0, -1, 1.5, '3600', null, undefined, {}, Number.NaN]) {
        expect(resolveInvoiceExpirySeconds(bad)).to.equal(DEFAULT_INVOICE_EXPIRY_SECONDS)
      }
    })
  })

  describe('resolveInvoiceExpiry', () => {
    it('uses the processor expiry when there is one', () => {
      const reported = new Date('2026-08-29T01:00:00.000Z')
      expect(resolveInvoiceExpiry(reported, createdAt)).to.equal(reported)
    })

    it('falls back when the processor reports nothing', () => {
      expect(resolveInvoiceExpiry(null, createdAt, 3600).toISOString()).to.equal('2026-08-29T01:00:00.000Z')
      expect(resolveInvoiceExpiry(undefined, createdAt, 3600).toISOString()).to.equal('2026-08-29T01:00:00.000Z')
    })

    it('falls back when the processor expiry did not parse', () => {
      expect(resolveInvoiceExpiry(new Date('nonsense'), createdAt, 3600).toISOString()).to.equal(
        '2026-08-29T01:00:00.000Z',
      )
    })

    it('uses the default lifetime when none is configured', () => {
      const expiry = resolveInvoiceExpiry(null, createdAt)
      expect(expiry.getTime() - createdAt.getTime()).to.equal(DEFAULT_INVOICE_EXPIRY_SECONDS * 1000)
    })

    it('always produces a usable date', () => {
      // Whatever comes in, the invoice must end up retirable.
      for (const badCreatedAt of [new Date('nonsense'), undefined as unknown as Date]) {
        const expiry = resolveInvoiceExpiry(null, badCreatedAt)
        expect(expiry).to.be.instanceOf(Date)
        expect(Number.isNaN(expiry.getTime())).to.equal(false)
      }
    })

    it('produces an expiry that isExpiredInvoice can eventually act on', () => {
      const past = new Date(Date.now() - 2 * DEFAULT_INVOICE_EXPIRY_SECONDS * 1000)
      expect(isExpiredInvoice({ expiresAt: resolveInvoiceExpiry(null, past) })).to.equal(true)
    })
  })
})
