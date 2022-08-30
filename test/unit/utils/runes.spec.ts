import { expect } from 'chai'
import sinon from 'sinon'

import { Alternative } from '../../../src/utils/runes/alternative'
import { Restriction } from '../../../src/utils/runes/restriction'

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

describe('Restriction', () => {
  describe('constructor', () => {
    it('throws if given alternatives list is empty', () => [
      expect(() => new Restriction([])).to.throw(Error, 'Restriction must have some alternatives'),
    ])
  })

  describe('test', () => {
    it('returns undefined given 1 true alternative', () => {
      const values = { a: 1 }
      const alternatives: Alternative[] = [
        { test: sinon.fake.returns(undefined) },
      ] as any

      expect(new Restriction(alternatives).test(values)).to.be.undefined

      expect(alternatives[0].test).to.have.been.calledOnceWithExactly(values)
    })

    it('returns undefined given 2 true alternative', () => {
      const values = { a: 1 }
      const alternatives: Alternative[] = [
        { test: sinon.fake.returns(undefined) },
        { test: sinon.fake.returns(undefined) },
      ] as any

      expect(new Restriction(alternatives).test(values)).to.be.undefined

      expect(alternatives[0].test).to.have.been.calledOnceWithExactly(values)
      expect(alternatives[1].test).not.to.have.been.called
    })

    it('returns undefined given 1 true and 1 false alternative', () => {
      const values = { a: 1 }
      const alternatives: Alternative[] = [
        { test: sinon.fake.returns(undefined) },
        { test: sinon.fake.returns('reason') },
      ] as any

      expect(new Restriction(alternatives).test(values)).to.be.undefined

      expect(alternatives[0].test).to.have.been.calledOnceWithExactly(values)
      expect(alternatives[1].test).not.to.have.been.called
    })

    it('returns reason given 1 false alternative', () => {
      const values = { a: 1 }
      const alternatives: Alternative[] = [
        { test: sinon.fake.returns('reason') },
      ] as any

      expect(new Restriction(alternatives).test(values)).to.equal('reason')

      expect(alternatives[0].test).to.have.been.calledOnceWithExactly(values)
    })

    it('returns undefined given 1 false and 1 true alternative', () => {
      const values = { a: 1 }
      const alternatives: Alternative[] = [
        { test: sinon.fake.returns('reason') },
        { test: sinon.fake.returns(undefined) },
      ] as any

      expect(new Restriction(alternatives).test(values)).to.be.undefined

      expect(alternatives[0].test).to.have.been.calledOnceWithExactly(values)
      expect(alternatives[1].test).to.have.been.calledOnceWithExactly(values)
    })

    it('returns reasons given 2 false alternatives', () => {
      const values = { a: 1 }
      const alternatives: Alternative[] = [
        { test: sinon.fake.returns('reason 1') },
        { test: sinon.fake.returns('reason 2') },
      ] as any

      expect(new Restriction(alternatives).test(values)).to.equal('reason 1 AND reason 2')

      expect(alternatives[0].test).to.have.been.calledOnceWithExactly(values)
      expect(alternatives[1].test).to.have.been.calledOnceWithExactly(values)
    })
  })

  describe('encode', () => {
    it('returns encoded restriction with 1 alternative', () => {
      const alternatives: Alternative[] = [
        { encode: sinon.fake.returns('a=1') },
      ] as any

      expect(new Restriction(alternatives).encode()).to.equal('a=1')
    })


    it('returns encoded restrictions with 2 alternatives', () => {
      const alternatives: Alternative[] = [
        { encode: sinon.fake.returns('a=1') },
        { encode: sinon.fake.returns('b=2') },
      ] as any

      expect(new Restriction(alternatives).encode()).to.equal('a=1|b=2')
    })
  })

  describe('decode', () => {
    it('returns encoded restriction given 1 alternative', () => {
      const [restriction, remainder] = Restriction.decode('a=1')

      expect(restriction.encode()).to.equal('a=1')
      expect(remainder).to.be.empty
    })

    it('returns encoded restriction given 2 alternatives', () => {
      const [restriction, remainder] = Restriction.decode('a=1|b=2')

      expect(restriction.encode()).to.equal('a=1|b=2')
      expect(remainder).to.be.empty
    })

    it('returns encoded restriction given 2 alternatives and another restriction', () => {
      const [restriction, remainder] = Restriction.decode('a=1|b=2&c=1')

      expect(restriction.encode()).to.equal('a=1|b=2')
      expect(remainder).to.equal('c=1')
    })
  })
})
