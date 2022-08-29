import { expect } from 'chai'
import sinon from 'sinon'

import { Alternative } from '../../../../src/utils/runes/alternative'
import { Restriction } from '../../../../src/utils/runes/restriction'

describe('Restriction', () => {
  describe('constructor', () => {
    it('throws if given alternatives list is empty', () => {
      expect(() => new Restriction([])).to.throw(Error, 'Restriction must have some alternatives')
    })
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
