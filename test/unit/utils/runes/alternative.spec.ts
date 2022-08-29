import { expect } from 'chai'
import sinon from 'sinon'

import { Alternative } from '../../../../src/utils/runes/alternative'

describe('Alternative', () => {
  describe('constructor', () => {
    it('throw error if field has punctuations', () => {
      expect(() => new Alternative('%', '=', 'value')).to.throw(Error, 'Field is not valid')
    })

    it('throw error if cond is not valid', () => {
      expect(() => new Alternative('field', '@', 'value')).to.throw(Error, 'Cond is not valid')
    })

    it('returns an Alternative if given valid fields', () => {
      expect(new Alternative('field', '=', 'value')).to.be.an.instanceOf(Alternative)
    })
  })

  describe('test', () => {
    it('returns undefined always if rule is #', () => {
      expect(new Alternative('', '#', '').test({})).to.be.undefined
    })

    it('returns reason if field not present with rule field=value', () => {
      expect(new Alternative('field', '=', 'value').test({})).to.equal('field: is missing')
    })

    it('returns undefined if field is not present with rule field!', () => {
      expect(new Alternative('field', '!', '').test({})).to.be.undefined
    })

    it('returns reason if field is present with rule field!', () => {
      expect(new Alternative('field', '!', '').test({ field: 'value' })).to.equal('field: is present')
    })

    it('calls function if field is a function', () => {
      const spy = sinon.fake.returns('reason')
      const alternative = new Alternative('field', '=', 'value')

      const result = alternative.test({ field: spy })

      expect(spy).to.have.been.calledOnceWithExactly(alternative)
      expect(result).to.equal('reason')
    })

    it('returns reason if field not equals value with rule field=value', () => {
      expect(new Alternative('field', '=', 'value').test({ field: 'not value' })).to.equal('field: != value')
    })

    it('returns undefined if field equals value with rule field=value', () => {
      expect(new Alternative('field', '=', 'value').test({ field: 'value' })).to.be.undefined
    })

    it('returns undefined if field not equals value with rule field/value', () => {
      expect(new Alternative('field', '/', 'value').test({ field: 'not value' })).to.be.undefined
    })

    it('returns reason if field equals value with rule field/value', () => {
      expect(new Alternative('field', '/', 'value').test({ field: 'value' })).to.equal('field: = value')
    })

    it('returns undefined if field starts with value with rule field^value', () => {
      expect(new Alternative('field', '^', 'value').test({ field: 'value <- here' })).to.be.undefined
    })

    it('returns reason if field does not start value with rule field^value', () => {
      expect(new Alternative('field', '^', 'value').test({ field: 'nope' })).to.equal('field: does not start with value')
    })

    it('returns undefined if field ends with value with rule field$value', () => {
      expect(new Alternative('field', '$', 'value').test({ field: 'ends -> value' })).to.be.undefined
    })

    it('returns reason if field does not end value with rule field$value', () => {
      expect(new Alternative('field', '$', 'value').test({ field: 'nope' })).to.equal('field: does not end with value')
    })

    it('returns undefined if field contains value with in string rule field~value', () => {
      expect(new Alternative('field', '~', 'value').test({ field: '-> value <-' })).to.be.undefined
    })

    it('returns reason if field does not contain value in string with rule field~value', () => {
      expect(new Alternative('field', '~', 'value').test({ field: 'nope' })).to.equal('field: does not contain value')
    })

    it('returns undefined if field contains value in array with rule field~value', () => {
      expect(new Alternative('field', '~', 'value').test({ field: ['value'] })).to.be.undefined
    })

    it('returns reason if field does not contain value in array with rule field~value', () => {
      expect(new Alternative('field', '~', 'value').test({ field: [] })).to.equal('field: does not contain value')
    })




    it('returns undefined if field is less than value with rule field<value', () => {
      expect(new Alternative('field', '<', '0').test({ field: -1 })).to.be.undefined
    })

    it('returns reason if field does not less than value with rule field<value', () => {
      expect(new Alternative('field', '<', '0').test({ field: 0 })).to.equal('field: >= 0')
    })

    it('returns undefined if field is greater than value with rule field>value', () => {
      expect(new Alternative('field', '>', '0').test({ field: 1 })).to.be.undefined
    })

    it('returns reason if field does not greater than value with rule field>value', () => {
      expect(new Alternative('field', '>', '0').test({ field: 0 })).to.equal('field: <= 0')
    })

    it('returns reason if field is not an integer with rule field<value', () => {
      expect(new Alternative('field', '<', '0').test({ field: 'not an integer' })).to.equal('field: not an integer field')
    })

    it('returns reason if field is not an integer with rule field>value', () => {
      expect(new Alternative('field', '>', '0').test({ field: 'not an integer' })).to.equal('field: not an integer field')
    })

    it('returns reason if field is not an integer with rule field<value', () => {
      expect(new Alternative('field', '<', 'not an integer').test({ field: 1 })).to.equal('field: not a valid integer')
    })

    it('returns reason if field is not an integer with rule field>value', () => {
      expect(new Alternative('field', '>', 'not an integer').test({ field: 1 })).to.equal('field: not a valid integer')
    })



    it('returns undefined if field is same as value with rule field{value', () => {
      expect(new Alternative('field', '{', 'b').test({ field: 'b' })).to.equal('field: is the same or ordered after b')
    })

    it('returns undefined if field is ordered before value with rule field{value', () => {
      expect(new Alternative('field', '{', 'b').test({ field: 'a' })).to.be.undefined
    })

    it('returns reason if field is ordered after value with rule field{value', () => {
      expect(new Alternative('field', '{', 'b').test({ field: 'c' })).to.equal('field: is the same or ordered after b')
    })

    it('returns undefined if field is same as value with rule field}value', () => {
      expect(new Alternative('field', '}', 'b').test({ field: 'b' })).to.equal('field: is the same or ordered before b')
    })

    it('returns undefined if field is ordered after value with rule field}value', () => {
      expect(new Alternative('field', '}', 'b').test({ field: 'c' })).to.be.undefined
    })

    it('returns reason if field is ordered before value with rule field}value', () => {
      expect(new Alternative('field', '}', 'b').test({ field: 'a' })).to.equal('field: is the same or ordered before b')
    })
  })

  describe('encode', () => {
    it('returns encoded alternative field = value', () => {
      expect(new Alternative('field', '=', 'value').encode()).to.equal('field=value')
    })

    it('returns encoded alternative #', () => {
      expect(new Alternative('', '#', '').encode()).to.equal('#')
    })

    it('returns encoded alternative field!', () => {
      expect(new Alternative('field', '!', '').encode()).to.equal('field!')
    })

    it('returns encoded alternative field=\\|&', () => {
      expect(new Alternative('field', '=', '\\|&').encode()).to.equal('field=\\\\\\|\\&')
    })
  })

  describe('decode', () => {
    it('decodes #', () => {
      const [alternative] = Alternative.decode('#')
      expect(alternative.encode()).to.equal('#')
    })

    it('decodes field!', () => {
      const [alternative] = Alternative.decode('field!')
      expect(alternative.encode()).to.equal('field!')
    })

    it('decodes field=value', () => {
      const [alternative] = Alternative.decode('field=value')
      expect(alternative.encode()).to.equal('field=value')
    })

    it('decodes field=\\\\\\|\\&', () => {
      const [alternative] = Alternative.decode('field=\\\\\\|\\&')
      expect(alternative.encode()).to.equal('field=\\\\\\|\\&')
    })

    it('throw error decoding value', () => {
      expect(() => Alternative.decode('value')).to.throw(Error, 'value does not contain any operator')
    })

    it('decodes until first | and consumes it', () => {
      const [alternative, remainder] = Alternative.decode('a=1|b=2')
      expect(alternative.encode()).to.equal('a=1')
      expect(remainder).to.equal('b=2')
    })

    it('decodes until first &', () => {
      const [alternative, remainder] = Alternative.decode('a=1&b=2')
      expect(alternative.encode()).to.equal('a=1')
      expect(remainder).to.equal('&b=2')
    })
  })

  describe('from', () => {
    it('creates alternative rule with spaces "field = value"', () => {
      expect(Alternative.from('field = value').encode()).to.equal('field=value')
    })
  })
})
