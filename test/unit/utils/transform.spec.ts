import { expect } from 'chai'

import { fromBech32, fromBuffer, fromNpub, toBech32, toBuffer, toJSON } from '../../../src/utils/transform'

describe('toJSON', () => {
  it('returns given value JSON stringified', () => {
    expect(toJSON({ a: 1 })).to.equal('{"a":1}')
  })
})

describe('toBuffer', () => {
  it('returns buffer given a hex string', () => {
    expect(toBuffer('aa55')).to.deep.equal(Buffer.from([0xaa, 0x55]))
  })
})

describe('fromBuffer', () => {
  it('returns given value JSON stringified', () => {
    expect(fromBuffer(Buffer.from('aa55', 'hex'))).to.equal('aa55')
  })
})

describe('fromNpub', () => {
  const hex = '22e804d26ed16b68db5259e78449e96dab5d464c8f470bda3eb1a70467f2c793'

  it('decodes an npub of 32 bytes to its hex', () => {
    expect(fromNpub(toBech32('npub')(hex))).to.equal(hex)
  })

  it('accepts an npub in upper case', () => {
    expect(fromNpub(toBech32('npub')(hex).toUpperCase())).to.equal(hex)
  })

  it('rejects an npub of fewer or more than 32 bytes, which fromBech32 would cut or accept', () => {
    expect(() => fromNpub(toBech32('npub')('a'.repeat(62)))).to.throw('32 bytes')
    expect(() => fromNpub(toBech32('npub')('a'.repeat(66)))).to.throw('32 bytes')
    expect(fromBech32(toBech32('npub')('a'.repeat(66)))).to.have.length(64)
  })

  it('rejects another prefix', () => {
    expect(() => fromNpub(toBech32('nsec')(hex))).to.throw('Expected an npub')
  })

  it('rejects mixed case', () => {
    expect(() => fromNpub(toBech32('npub')(hex).replace('n', 'N'))).to.throw('mixed-case')
  })

  it('rejects a bad checksum and text that is not bech32', () => {
    const npub = toBech32('npub')(hex)

    expect(() => fromNpub(`${npub.slice(0, -1)}${npub.endsWith('q') ? 'p' : 'q'}`)).to.throw()
    expect(() => fromNpub('not an npub')).to.throw()
  })
})
