import { expect } from 'chai'

import { Settings } from '../../../src/@types/settings'
import {
  InvalidPeeringTermError,
  isPeeringInvoiceRequest,
  resolvePaidPeeringTerm,
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
