import chai from 'chai'
import sinon from 'sinon'
import sinonChai from 'sinon-chai'

chai.use(sinonChai)
const { expect } = chai

import * as settingsFactory from '../../../../src/factories/settings-factory'
import * as templateCache from '../../../../src/utils/template-cache'
import { getTermsRequestHandler } from '../../../../src/handlers/request-handlers/get-terms-request-handler'

describe('getTermsRequestHandler', () => {
  let createSettingsStub: sinon.SinonStub
  let getTemplateStub: sinon.SinonStub
  let res: any
  let next: sinon.SinonStub

  beforeEach(() => {
    createSettingsStub = sinon.stub(settingsFactory, 'createSettings')
    getTemplateStub = sinon.stub(templateCache, 'getTemplate')

    createSettingsStub.returns({ info: { name: 'Test Relay' } })

    res = {
      status: sinon.stub().returnsThis(),
      setHeader: sinon.stub().returnsThis(),
      send: sinon.stub().returnsThis(),
      locals: { nonce: 'terms-nonce' },
    }
    next = sinon.stub()
  })

  afterEach(() => {
    createSettingsStub.restore()
    getTemplateStub.restore()
  })

  it('loads the terms.html template', () => {
    getTemplateStub.returns('')

    getTermsRequestHandler({} as any, res, next)

    expect(getTemplateStub).to.have.been.calledWith('./resources/terms.html')
  })

  it('responds with 200 and text/html content-type', () => {
    getTemplateStub.returns('')

    getTermsRequestHandler({} as any, res, next)

    expect(res.status).to.have.been.calledWith(200)
    expect(res.setHeader).to.have.been.calledWith('content-type', 'text/html; charset=utf8')
  })

  it('HTML-escapes the relay name', () => {
    createSettingsStub.returns({ info: { name: '<evil>Relay</evil>' } })
    getTemplateStub.returns('{{name}}')

    getTermsRequestHandler({} as any, res, next)

    const sent = res.send.firstCall.args[0]
    expect(sent).to.not.include('<evil>')
    expect(sent).to.include('&lt;evil&gt;')
  })

  it('injects the CSP nonce', () => {
    getTemplateStub.returns('{{nonce}}')

    getTermsRequestHandler({} as any, res, next)

    expect(res.send.firstCall.args[0]).to.equal('terms-nonce')
  })

  it('calls next with error when template read fails', () => {
    const err = new Error('template missing')
    getTemplateStub.throws(err)

    getTermsRequestHandler({} as any, res, next)

    expect(next).to.have.been.calledWith(err)
    expect(res.send).to.not.have.been.called
  })
})
