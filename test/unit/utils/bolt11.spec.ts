import { expect } from 'chai'

import { bolt11PaymentHash, decodeBolt11 } from '../../../src/utils/bolt11'

// BOLT11 spec test vector: 2500 microbitcoin, payment hash 000102...0102.
const INVOICE =
  'lnbc2500u1pvjluezsp5zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygspp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqdq5xysxxatsyp3k7enxv4jsxqzpu9qrsgquk0rl77nj30yxdy8j9vdx85fkpmdla2087ne0xh8nhedh8w27kyke0lp53ut353s06fv3qfegext0eh0ymjpf39tuven09sam30g4vgpfna3rh'

describe('decodeBolt11', () => {
  it('reads the BOLT11 payment hash and amount', () => {
    expect(decodeBolt11(INVOICE)).to.deep.equal({
      paymentHash: '0001020304050607080900010203040506070809000102030405060708090102',
      amountMsats: 250_000_000n,
      network: 'bc',
    })
  })

  it('accepts an uppercase invoice', () => {
    expect(decodeBolt11(INVOICE.toUpperCase()).paymentHash).to.equal(
      '0001020304050607080900010203040506070809000102030405060708090102',
    )
  })

  it('exposes a payment-hash helper', () => {
    expect(bolt11PaymentHash(INVOICE)).to.equal('0001020304050607080900010203040506070809000102030405060708090102')
  })

  it('rejects an invoice longer than the parser bound', () => {
    expect(() => decodeBolt11(`lnbc1${'q'.repeat(1_000)}`)).to.throw('Invalid bolt11 invoice')
  })

  it('rejects a broken checksum', () => {
    expect(() => decodeBolt11(`${INVOICE.slice(0, -1)}q`)).to.throw('Invalid bolt11 checksum')
  })

  it('rejects a non-invoice bech32 string', () => {
    expect(() => decodeBolt11('not-an-invoice')).to.throw()
  })
})
