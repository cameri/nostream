import chai from 'chai'
import sinon from 'sinon'
import sinonChai from 'sinon-chai'

import { getHealthRequestHandler } from '../../../../src/handlers/request-handlers/get-health-request-handler'

chai.use(sinonChai)
const { expect } = chai

describe('getHealthRequestHandler', () => {
  it('responds with OK plain text and calls next', () => {
    const req = {} as any
    const res = {
      status: sinon.stub().returnsThis(),
      setHeader: sinon.stub().returnsThis(),
      send: sinon.stub().returnsThis(),
    } as any
    const next = sinon.stub()

    getHealthRequestHandler(req, res, next)

    expect(res.status).to.have.been.calledOnceWithExactly(200)
    expect(res.setHeader).to.have.been.calledOnceWithExactly('content-type', 'text/plain; charset=utf8')
    expect(res.send).to.have.been.calledOnceWithExactly('OK')
    expect(next).to.have.been.calledOnce
  })
})
