import chai from 'chai'
import sinon from 'sinon'
import sinonChai from 'sinon-chai'

chai.use(sinonChai)
const { expect } = chai

import * as fs from 'fs'
import { getTemplate } from '../../../src/utils/template-cache'

describe('getTemplate', () => {
  let readFileSyncStub: sinon.SinonStub

  beforeEach(() => {
    readFileSyncStub = sinon.stub(fs, 'readFileSync').returns('template content' as any)
  })

  afterEach(() => {
    readFileSyncStub.restore()
  })

  it('returns the file content', () => {
    const result = getTemplate('./resources/index.html')

    expect(result).to.equal('template content')
  })

  it('reads the file with utf8 encoding', () => {
    getTemplate('./resources/index.html')

    expect(readFileSyncStub).to.have.been.calledWith('./resources/index.html', 'utf8')
  })

  it('reads the file on every call in non-production mode', () => {
    // NODE_ENV is not 'production' in tests — cache is bypassed
    getTemplate('./resources/index.html')
    getTemplate('./resources/index.html')

    expect(readFileSyncStub).to.have.been.calledTwice
  })

  it('propagates errors thrown by readFileSync', () => {
    readFileSyncStub.throws(new Error('file not found'))

    expect(() => getTemplate('./resources/missing.html')).to.throw('file not found')
  })
})
