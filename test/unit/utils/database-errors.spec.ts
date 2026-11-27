import { expect } from 'chai'

import { isSerializationFailure } from '../../../src/utils/database-errors'

describe('database errors', () => {
  it('recognizes PostgreSQL serialization failures', () => {
    expect(isSerializationFailure({ code: '40001' })).to.equal(true)
  })

  it('walks wrapped errors', () => {
    expect(isSerializationFailure({ original: { code: '40001' } })).to.equal(true)
    expect(isSerializationFailure({ cause: { original: { code: '40001' } } })).to.equal(true)
  })

  it('ignores unrelated and malformed errors', () => {
    expect(isSerializationFailure(new Error('boom'))).to.equal(false)
    expect(isSerializationFailure({ code: '23505' })).to.equal(false)
    expect(isSerializationFailure(undefined)).to.equal(false)
  })
})
