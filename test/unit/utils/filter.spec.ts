import { expect } from 'chai'

import { countFilterValues, isGenericTagQuery } from '../../../src/utils/filter'

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

describe('countFilterValues', () => {
  it('returns zero for a filter without array criteria', () => {
    expect(countFilterValues({})).to.equal(0)
  })

  it('sums values across every array criterion', () => {
    expect(countFilterValues({ ids: ['aa'], authors: ['bb', 'cc'], kinds: [1, 2, 3] })).to.equal(6)
  })

  it('counts generic tag criteria', () => {
    expect(countFilterValues({ '#e': ['aa', 'bb'], '#p': ['cc'] })).to.equal(3)
  })

  it('does not count scalar criteria', () => {
    expect(countFilterValues({ ids: ['aa'], since: 1, until: 2, limit: 3, search: 'aa bb cc' })).to.equal(1)
  })

  it('does not count empty criteria', () => {
    expect(countFilterValues({ ids: [], authors: ['aa'] })).to.equal(1)
  })
})
