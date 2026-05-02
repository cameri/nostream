import { assocPath } from 'ramda'
import { expect } from 'chai'

import { filterSchema } from '../../../src/schemas/filter-schema'
import { SubscriptionFilter } from '../../../src/@types/subscription'
import { validateSchema } from '../../../src/utils/validation'

describe('NIP-01', () => {
  let filter: SubscriptionFilter
  describe('validate filter schema', () => {
    beforeEach(() => {
      filter = {
        ids: ['aaaa', 'bbbb', 'cccc'],
        authors: ['aaaa', 'bbbb', 'cccc'],
        kinds: [0, 1, 2, 3],
        since: 1000,
        until: 1000,
        limit: 100,
        '#e': ['aa', 'bb', 'cc'],
        '#p': ['dd', 'ee', 'ff'],
        '#r': ['00', '11', '22'],
      }
    })

    it('accepts NIP-22 comment threading filters for kind 1111', () => {
      const nip22Filter = {
        kinds: [1111],
        '#E': ['aaaa'],
        '#K': ['1'],
        '#I': ['identifier1'],
        '#A': ['10000:pubkey:dtag'],
      }
      const result = validateSchema(filterSchema)(nip22Filter)
      expect(result.error).to.be.undefined
      expect(result.value).to.deep.equal(nip22Filter)
    })

    it('accepts uppercase tag filters (#A-Z)', () => {
      const filterWithUppercase = {
        ...filter,
        '#I': ['identifier1', 'identifier2'],
        '#K': ['1111'],
        '#E': ['aa', 'bb'],
        '#A': ['10000:pubkey:dtag'],
      }
      const result = validateSchema(filterSchema)(filterWithUppercase)
      expect(result.error).to.be.undefined
      expect(result.value).to.deep.equal(filterWithUppercase)
    })

    it('returns same filter if filter is valid', () => {
      const result = validateSchema(filterSchema)(filter)

      expect(result.error).to.be.undefined
      expect(result.value).to.deep.equal(filter)
    })

    it('accepts empty strings in generic tag filters', () => {
      const filterWithEmptyTagValue = {
        '#d': [''],
      }

      const result = validateSchema(filterSchema)(filterWithEmptyTagValue)

      expect(result.error).to.be.undefined
      expect(result.value).to.deep.equal(filterWithEmptyTagValue)
    })

    const cases = {
      ids: [{ message: 'must be an array', transform: assocPath(['ids'], null) }],
      prefixOrId: [
        {
          message: 'length must be less than or equal to 64 characters long',
          transform: assocPath(['ids', 0], 'f'.repeat(65)),
        },
        { message: 'must only contain hexadecimal characters', transform: assocPath(['ids', 0], 'not hex') },
        { message: 'is not allowed to be empty', transform: assocPath(['ids', 0], '') },
      ],
      authors: [{ message: 'must be an array', transform: assocPath(['authors'], null) }],
      prefixOrAuthor: [
        {
          message: 'length must be less than or equal to 64 characters long',
          transform: assocPath(['authors', 0], 'f'.repeat(65)),
        },
        { message: 'must only contain hexadecimal characters', transform: assocPath(['authors', 0], 'not hex') },
        { message: 'is not allowed to be empty', transform: assocPath(['authors', 0], '') },
      ],
      kinds: [{ message: 'must be an array', transform: assocPath(['kinds'], null) }],
      kind: [
        { message: 'must be greater than or equal to 0', transform: assocPath(['kinds', 0], -1) },
        { message: 'must be a number', transform: assocPath(['kinds', 0], null) },
        { message: 'must be a multiple of 1', transform: assocPath(['kinds', 0], Math.PI) },
      ],
      since: [
        { message: 'contains an invalid value', transform: assocPath(['since'], 1672295751103) },
        { message: 'must be a number', transform: assocPath(['since'], null) },
        { message: 'must be greater than or equal to 0', transform: assocPath(['since'], -1) },
        { message: 'must be a multiple of 1', transform: assocPath(['since'], Math.PI) },
      ],
      until: [
        { message: 'contains an invalid value', transform: assocPath(['until'], 1672295751103) },
        { message: 'must be a number', transform: assocPath(['until'], null) },
        { message: 'must be greater than or equal to 0', transform: assocPath(['until'], -1) },
        { message: 'must be a multiple of 1', transform: assocPath(['until'], Math.PI) },
      ],
      limit: [
        { message: 'must be a number', transform: assocPath(['limit'], null) },
        { message: 'must be greater than or equal to 0', transform: assocPath(['limit'], -1) },
        { message: 'must be a multiple of 1', transform: assocPath(['limit'], Math.PI) },
      ],
      '#e': [{ message: 'must be an array', transform: assocPath(['#e'], null) }],
      '#e[0]': [
        {
          message: 'length must be less than or equal to 1024 characters long',
          transform: assocPath(['#e', 0], 'f'.repeat(1024 + 1)),
        },
      ],
      '#p': [{ message: 'must be an array', transform: assocPath(['#p'], null) }],
      '#p[0]': [
        {
          message: 'length must be less than or equal to 1024 characters long',
          transform: assocPath(['#p', 0], 'f'.repeat(1024 + 1)),
        },
      ],
      '#r': [{ message: 'must be an array', transform: assocPath(['#r'], null) }],
      '#r[0]': [
        {
          message: 'length must be less than or equal to 1024 characters long',
          transform: assocPath(['#r', 0], 'f'.repeat(1024 + 1)),
        },
      ],
    }

    for (const prop in cases) {
      describe(prop, () => {
        cases[prop].forEach(({ transform, message }) => {
          it(`${prop} ${message}`, () =>
            expect(validateSchema(filterSchema)(transform(filter))).to.have.property('error').that.is.not.undefined)
        })
      })
    }
  })
})

describe('NIP-12', () => {
  describe('#g filter validation', () => {
    it('accepts a valid base32 geohash', () => {
      const result = validateSchema(filterSchema)({ '#g': ['u4pruydqqvj'] })
      expect(result.error).to.be.undefined
    })

    it('accepts a valid geohash prefix with trailing wildcard', () => {
      const result = validateSchema(filterSchema)({ '#g': ['u4pruyd*'] })
      expect(result.error).to.be.undefined
    })

    it('rejects an empty criterion', () => {
      const result = validateSchema(filterSchema)({ '#g': [''] })
      expect(result.error).to.not.be.undefined
    })

    it('rejects a bare wildcard', () => {
      const result = validateSchema(filterSchema)({ '#g': ['*'] })
      expect(result.error).to.not.be.undefined
    })

    it('rejects non-base32 characters', () => {
      const result = validateSchema(filterSchema)({ '#g': ['u4pruyda'] })
      expect(result.error).to.not.be.undefined
    })

    it('rejects uppercase characters', () => {
      const result = validateSchema(filterSchema)({ '#g': ['U4PRUYDQQVJ'] })
      expect(result.error).to.not.be.undefined
    })

    it('rejects wildcard not at the end', () => {
      const result = validateSchema(filterSchema)({ '#g': ['u4*pruyd'] })
      expect(result.error).to.not.be.undefined
    })

    it('rejects multiple wildcards', () => {
      const result = validateSchema(filterSchema)({ '#g': ['u4pruyd**'] })
      expect(result.error).to.not.be.undefined
    })
  })
})
