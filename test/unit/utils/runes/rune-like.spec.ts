import { expect } from 'chai'
import sinon from 'sinon'

import { Alternative } from '../../../../src/utils/runes/alternative'
import { Restriction } from '../../../../src/utils/runes/restriction'
import { RuneLike } from '../../../../src/utils/runes/rune-like'

describe('RuneLike', () => {
  describe('test', () => {
    it('returns true if 1 restriction is true', () => {
      const values = { a: 1 }
      const restrictions: Restriction[] = [
        { test: sinon.fake.returns(undefined) } as any,
      ]

      expect(new RuneLike(restrictions).test(values)).to.deep.equal([true, ''])
      expect(restrictions[0].test).to.have.been.calledOnceWithExactly(values)
    })

    it('returns false and reason if 1 restriction is false', () => {
      const values = { a: 1 }
      const restrictions: Restriction[] = [
        { test: sinon.fake.returns('reason') } as any,
      ]

      expect(new RuneLike(restrictions).test(values)).to.deep.equal([false, 'reason'])
      expect(restrictions[0].test).to.have.been.calledOnceWithExactly(values)
    })

    it('returns false if 1 restriction is true and 1 is false', () => {
      const values = { a: 1 }
      const restrictions: Restriction[] = [
        { test: sinon.fake.returns(undefined) } as any,
        { test: sinon.fake.returns('reason 2') } as any,
      ]

      expect(new RuneLike(restrictions).test(values)).to.deep.equal([false, 'reason 2'])
      expect(restrictions[0].test).to.have.been.calledOnceWithExactly(values)
      expect(restrictions[1].test).to.have.been.calledOnceWithExactly(values)
    })

    it('returns false if 1 restriction is false and 1 is true', () => {
      const values = { a: 1 }
      const restrictions: Restriction[] = [
        { test: sinon.fake.returns('reason 1') } as any,
        { test: sinon.fake.returns(undefined) } as any,
      ]

      expect(new RuneLike(restrictions).test(values)).to.deep.equal([false, 'reason 1'])
      expect(restrictions[0].test).to.have.been.calledOnceWithExactly(values)
      expect(restrictions[1].test).not.to.have.been.called
    })

    it('returns false if 2 restrictions are false', () => {
      const values = { a: 1 }
      const restrictions: Restriction[] = [
        { test: sinon.fake.returns('reason 1') } as any,
        { test: sinon.fake.returns('reason 2') } as any,
      ]

      expect(new RuneLike(restrictions).test(values)).to.deep.equal([false, 'reason 1'])
      expect(restrictions[0].test).to.have.been.calledOnceWithExactly(values)
      expect(restrictions[1].test).not.to.have.been.called
    })
  })

  describe('encode', () => {
    it('encodes 1 restriction', () => {
      const restrictions: Restriction[] = [
        { encode: sinon.fake.returns('a=1') },
      ] as any

      expect(new RuneLike(restrictions).encode()).to.equal('a=1')
    })

    it('encodes 2 restrictions', () => {
      const restrictions: Restriction[] = [
        { encode: sinon.fake.returns('a=1') },
        { encode: sinon.fake.returns('b=2') },
      ] as any

      expect(new RuneLike(restrictions).encode()).to.equal('a=1&b=2')
    })
  })

  describe('from', () => {
    let restrictionDecodeStub: sinon.SinonStub
    beforeEach(() => {
      restrictionDecodeStub = sinon.stub(Restriction, 'decode')
    })

    afterEach(() => {
      restrictionDecodeStub.restore()
    })

    it('returns rune-like given restrictions a=1', () => {
      restrictionDecodeStub.withArgs('a=1').returns([
        new Restriction([
          new Alternative('a', '=', '1'),
        ]),
        '',
      ])
      const runeLike = RuneLike.from('a=1')

      expect(runeLike).to.be.an.instanceOf(RuneLike)

      expect(restrictionDecodeStub.firstCall).to.have.been.calledWithExactly('a=1')
      expect(runeLike.encode()).to.equal('a=1')
    })

    it('returns rune-like given restrictions a=1|b=2', () => {
      restrictionDecodeStub.withArgs('a=1|b=2').returns([
        new Restriction([
          new Alternative('a', '=', '1'),
          new Alternative('b', '=', '2'),
        ]),
        '',
      ])
      const runeLike = RuneLike.from('a=1|b=2')

      expect(runeLike).to.be.an.instanceOf(RuneLike)

      expect(restrictionDecodeStub.firstCall).to.have.been.calledWithExactly('a=1|b=2')
      expect(runeLike.encode()).to.equal('a=1|b=2')
    })

    it('returns rune-like given restrictions a=1|b=2&c=3', () => {
      restrictionDecodeStub.withArgs('a=1|b=2&c=3').returns([
        new Restriction([
          new Alternative('a', '=', '1'),
          new Alternative('b', '=', '2'),
        ]),
        '&c=3',
      ])
      restrictionDecodeStub.withArgs('&c=3').returns([
        new Restriction([
          new Alternative('c', '=', '3'),
        ]),
        '',
      ])
      const runeLike = RuneLike.from('a=1|b=2&c=3')

      expect(runeLike).to.be.an.instanceOf(RuneLike)

      expect(restrictionDecodeStub.firstCall).to.have.been.calledWithExactly('a=1|b=2&c=3')
      expect(restrictionDecodeStub.secondCall).to.have.been.calledWithExactly('&c=3')
      expect(runeLike.encode()).to.equal('a=1|b=2&c=3')
    })

    it('returns rune-like given restrictions with spaces a = 1 | b = 2 & c = 3', () => {
      restrictionDecodeStub.withArgs('a=1|b=2&c=3').returns([
        new Restriction([
          new Alternative('a', '=', '1'),
          new Alternative('b', '=', '2'),
        ]),
        '&c=3',
      ])
      restrictionDecodeStub.withArgs('&c=3').returns([
        new Restriction([
          new Alternative('c', '=', '3'),
        ]),
        '',
      ])
      const runeLike = RuneLike.from('a = 1 | b = 2 & c = 3')

      expect(runeLike).to.be.an.instanceOf(RuneLike)

      expect(restrictionDecodeStub.firstCall).to.have.been.calledWithExactly('a=1|b=2&c=3')
      expect(restrictionDecodeStub.secondCall).to.have.been.calledWithExactly('&c=3')
      expect(runeLike.encode()).to.equal('a=1|b=2&c=3')
    })
  })
})
