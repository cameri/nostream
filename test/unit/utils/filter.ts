import { expect } from 'chai'

import { isGenericTagQuery } from '../../../src/utils/filter'

describe('isGenericTagQuery', () => {
  it('returns true for #a', () => {
    expect(isGenericTagQuery('#a')).to.be.true
  })

  it('returns true for #A', () => {
    expect(isGenericTagQuery('#A')).to.be.true
  })

  it('returns false for #0', () => {
    expect(isGenericTagQuery('#0')).to.be.false
  })

  it('returns false for #abc', () => {
    expect(isGenericTagQuery('#abc')).to.be.false
  })
})
