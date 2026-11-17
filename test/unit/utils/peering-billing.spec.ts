import { expect } from 'chai'

import { Settings } from '../../../src/@types/settings'
import {
  InvalidPeeringTermError,
  isPeeringInvoiceRequest,
  peeringBudgetWindow,
  peeringPaymentRequiredReason,
  resolvePaidPeeringTerm,
  resolvePeeringBudget,
} from '../../../src/utils/peering-billing'

const withTerms = (terms: unknown[]): Settings =>
  ({
    peering: {
      enabled: true,
      terms,
    },
  }) as Settings

describe('resolvePaidPeeringTerm', () => {
  it('returns undefined when there are no terms or only zero-amount terms', () => {
    expect(resolvePaidPeeringTerm(withTerms([]))).to.be.undefined
    expect(resolvePaidPeeringTerm(withTerms([{ amount: 0, unit: 'msats', period: 2592000 }]))).to.be.undefined
  })

  it('normalizes a valid msats term', () => {
    expect(resolvePaidPeeringTerm(withTerms([{ amount: 21000, unit: 'msats', period: 2592000 }]))).to.deep.equal({
      amountMsats: 21000n,
      periodSeconds: 2592000,
    })
  })

  it('normalizes sats and btc terms', () => {
    expect(resolvePaidPeeringTerm(withTerms([{ amount: 21, unit: 'sats', period: 60 }]))).to.deep.equal({
      amountMsats: 21000n,
      periodSeconds: 60,
    })
    expect(resolvePaidPeeringTerm(withTerms([{ amount: 1, unit: 'btc', period: 60 }]))).to.deep.equal({
      amountMsats: 100_000_000_000n,
      periodSeconds: 60,
    })
  })

  it('fails closed for malformed amounts instead of granting free peering', () => {
    for (const amount of ['21000', 21.5, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => resolvePaidPeeringTerm(withTerms([{ amount, unit: 'msats', period: 60 }]))).to.throw(
        InvalidPeeringTermError,
      )
    }
  })

  it('rejects an unsupported unit', () => {
    expect(() => resolvePaidPeeringTerm(withTerms([{ amount: 1, unit: 'usd', period: 60 }]))).to.throw(
      InvalidPeeringTermError,
    )
  })

  it('rejects a sub-satoshi msat term', () => {
    expect(() => resolvePaidPeeringTerm(withTerms([{ amount: 1500, unit: 'msats', period: 60 }]))).to.throw(
      InvalidPeeringTermError,
    )
  })

  it('rejects an amount whose satoshi value exceeds Number.MAX_SAFE_INTEGER', () => {
    // 100,000,000 BTC = 10^16 sats, above Number.MAX_SAFE_INTEGER. The processor
    // adapters convert msats to sats with Number(), so this must fail closed.
    expect(() =>
      resolvePaidPeeringTerm(withTerms([{ amount: 100_000_000, unit: 'btc', period: 60 }])),
    ).to.throw(InvalidPeeringTermError)
  })

  it('rejects an invalid period', () => {
    expect(() => resolvePaidPeeringTerm(withTerms([{ amount: 1000, unit: 'msats', period: 0 }]))).to.throw(
      InvalidPeeringTermError,
    )
  })

  it('exempts only requests where every filter is an invoice filter', () => {
    const peer = 'a'.repeat(64)
    const invoice = { kinds: [402], '#p': [peer], '#t': ['peering'] }

    expect(isPeeringInvoiceRequest([invoice], peer)).to.be.true
    expect(isPeeringInvoiceRequest([invoice, { kinds: [1] }], peer)).to.be.false
    expect(isPeeringInvoiceRequest([], peer)).to.be.false
  })
})

describe('peering budget windows', () => {
  it('resolves a configured budget to msats', () => {
    expect(resolvePeeringBudget({ amount: 10000, unit: 'sats', period: 3600 })).to.deep.equal({
      amountMsats: 10_000_000n,
      periodSeconds: 3600,
    })
  })

  it('treats a zero budget as no budget', () => {
    expect(resolvePeeringBudget({ amount: 0, unit: 'sats', period: 3600 })).to.be.undefined
    expect(resolvePeeringBudget(undefined)).to.be.undefined
  })

  it('aligns a budget window to the period boundary', () => {
    const window = peeringBudgetWindow(new Date('2026-11-18T12:34:56.000Z'), 3600)

    expect(window.start.toISOString()).to.equal('2026-11-18T12:00:00.000Z')
    expect(window.end.toISOString()).to.equal('2026-11-18T13:00:00.000Z')
  })
})

describe('peeringPaymentRequiredReason', () => {  it('prefixes an unprefixed denial reason', () => {
    expect(peeringPaymentRequiredReason({ reason: 'peering access lapsed' })).to.equal(
      'payment-required: peering access lapsed',
    )
  })

  it('keeps an already-prefixed reason unchanged', () => {
    expect(peeringPaymentRequiredReason({ reason: 'payment-required: settle the invoice' })).to.equal(
      'payment-required: settle the invoice',
    )
  })

  it('falls back to the invoice hint when there is no reason', () => {
    expect(peeringPaymentRequiredReason({})).to.equal(
      'payment-required: peering payment required; request the kind 402 peering invoice',
    )
  })
})
