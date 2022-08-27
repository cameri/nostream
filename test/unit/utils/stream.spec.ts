import * as chai from 'chai'
import * as sinon from 'sinon'
import sinonChai from 'sinon-chai'

import { streamEach, streamEnd, streamFilter, streamMap } from '../../../src/utils/stream'

chai.use(sinonChai)

const { expect } = chai

describe('streamMap', () => {
  it('transforms chunk with given function', () => {
    const spy = sinon.spy()
    const sum = ({ a, b }: { a: number, b: number }) => ({ sum: a + b })

    const stream = streamMap(sum)
    stream.on('data', spy)
    stream.write({ a: 1, b: 2 })
    stream.write({ a: 10, b: 20 })
    stream.end()

    expect(spy).to.have.been.calledTwice
    expect(spy.firstCall).to.have.been.calledWithExactly({ sum: 3 })
    expect(spy.secondCall).to.have.been.calledWithExactly({ sum: 30 })
  })
})

describe('streamEach', () => {
  it('calls given function for each value in stream', () => {
    const spy = sinon.spy()

    const stream = streamEach(spy)
    stream.write({ a: 1 })
    stream.write({ b: 2 })
    stream.end()

    expect(spy).to.have.been.calledTwice
    expect(spy.firstCall).to.have.been.calledWithExactly({ a: 1 })
    expect(spy.secondCall).to.have.been.calledWithExactly({ b: 2 })
  })
})

describe('streamEnd', () => {
  it('calls given function for each value in stream', () => {
    const spy = sinon.spy()

    const stream = streamEnd(spy)
    stream.write({ a: 1 })
    stream.write({ b: 2 })
    stream.end()
    stream.end()

    expect(spy).to.have.been.calledOnce
  })
})

describe('streamFilter', () => {
  it('passes elements that pass the given predicate downstream', () => {
    const spy = sinon.spy()

    const stream = streamFilter(({ a }) => a > 1 && a < 4)
    stream.on('data', spy)
    stream.write({ a: 1 })
    stream.write({ a: 2 })
    stream.write({ a: 3 })
    stream.write({ a: 4 })
    stream.end()

    expect(spy).to.have.been.calledTwice
    expect(spy.firstCall).to.have.been.calledWithExactly({ a: 2 })
    expect(spy.secondCall).to.have.been.calledWithExactly({ a: 3 })
  })
})
