import { expect } from 'chai'

import { fromBuffer, toBuffer, toJSON } from '../../../src/utils/transform'


describe('toJSON', () => {
  it('returns given value JSON stringified', () => {
    expect(toJSON({ a: 1 })).to.equal('{"a":1}')
  })
})

describe('toBuffer', () => {
  it('returns buffer given a hex string', () => {
    expect(toBuffer('aa55')).to.deep.equal(Buffer.from([0xAA, 0x55]))
  })
})

describe('fromBuffer', () => {
  it('returns given value JSON stringified', () => {
    expect(fromBuffer(Buffer.from('aa55', 'hex'))).to.equal('aa55')
  })
})
