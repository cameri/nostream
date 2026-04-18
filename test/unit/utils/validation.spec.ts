import { z, ZodError } from 'zod'
import { expect } from 'chai'

import { attemptValidation, validateSchema } from '../../../src/utils/validation'

describe('attemptValidation', () => {
  it('returns value if given value matches schema', () => {
    const schema = z.string()

    expect(attemptValidation(schema)('string')).to.equal('string')
  })

  it('throws error if given value does not match schema', () => {
    const schema = z.string()

    expect(() => attemptValidation(schema)(1)).to.throw(ZodError)
  })
})

describe('validateSchema', () => {
  it('returns value property with given value if it matches schema', () => {
    const schema = z.string()

    expect(validateSchema(schema)('string')).to.have.property('value', 'string')
  })

  it('returns error property with ZodError if given value does not match schema', () => {
    const schema = z.string()

    expect(validateSchema(schema)(1)).to.have.property('error').and.be.an.instanceOf(ZodError)
  })
})
