import chai from 'chai'
import sinon from 'sinon'
import sinonChai from 'sinon-chai'

chai.use(sinonChai)
const { expect } = chai

import * as settingsFactory from '../../../../src/factories/settings-factory'
import * as templateCache from '../../../../src/utils/template-cache'
import { rootRequestHandler } from '../../../../src/handlers/request-handlers/root-request-handler'

const baseSettings = {
  info: {
    name: 'Test Relay',
    description: 'A test relay',
    pubkey: 'abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234',
    contact: 'test@example.com',
    relay_url: 'wss://relay.example.com',
  },
  network: { maxPayloadSize: 65536 },
  limits: {
    client: { subscription: {} },
    event: { content: { maxLength: 8196 }, eventId: {} },
  },
  payments: {
    enabled: false,
    processor: 'lnbits',
    feeSchedules: { admission: [] },
  },
}

const settingsWithFee = {
  ...baseSettings,
  payments: {
    enabled: true,
    processor: 'lnbits',
    feeSchedules: {
      admission: [{ enabled: true, amount: 21000 }],
    },
  },
}

describe('rootRequestHandler', () => {
  let createSettingsStub: sinon.SinonStub
  let getTemplateStub: sinon.SinonStub
  let res: any
  let next: sinon.SinonStub

  beforeEach(() => {
    createSettingsStub = sinon.stub(settingsFactory, 'createSettings')
    getTemplateStub = sinon.stub(templateCache, 'getTemplate')

    res = {
      status: sinon.stub().returnsThis(),
      setHeader: sinon.stub().returnsThis(),
      send: sinon.stub().returnsThis(),
      redirect: sinon.stub(),
      locals: { nonce: 'test-nonce' },
    }
    next = sinon.stub()
  })

  afterEach(() => {
    createSettingsStub.restore()
    getTemplateStub.restore()
  })

  describe('when Accept: application/nostr+json', () => {
    let req: any

    beforeEach(() => {
      createSettingsStub.returns(baseSettings)
      req = {
        headers: { accept: 'application/nostr+json' },
        header: (name: string) =>
          name === 'accept' ? 'application/nostr+json' : undefined,
      }
    })

    it('responds with 200 and application/nostr+json content-type', () => {
      rootRequestHandler(req, res, next)

      expect(res.setHeader).to.have.been.calledWith('content-type', 'application/nostr+json')
      expect(res.status).to.have.been.calledWith(200)
    })

    it('includes the relay name in the response', () => {
      rootRequestHandler(req, res, next)

      const doc = res.send.firstCall.args[0]
      expect(doc.name).to.equal('Test Relay')
    })

    it('does not render the HTML template', () => {
      rootRequestHandler(req, res, next)

      expect(getTemplateStub).to.not.have.been.called
    })
  })

  describe('when serving HTML', () => {
    let req: any

    beforeEach(() => {
      req = { headers: { accept: 'text/html' }, header: () => undefined }
    })

    it('loads the index.html template', () => {
      createSettingsStub.returns(baseSettings)
      getTemplateStub.returns('')

      rootRequestHandler(req, res, next)

      expect(getTemplateStub).to.have.been.calledWith('./resources/index.html')
    })

    it('responds with 200 and text/html content-type', () => {
      createSettingsStub.returns(baseSettings)
      getTemplateStub.returns('')

      rootRequestHandler(req, res, next)

      expect(res.status).to.have.been.calledWith(200)
      expect(res.setHeader).to.have.been.calledWith('content-type', 'text/html; charset=utf8')
    })

    it('HTML-escapes the relay name', () => {
      createSettingsStub.returns({
        ...baseSettings,
        info: { ...baseSettings.info, name: '<b>Relay</b>' },
      })
      getTemplateStub.returns('{{name}}')

      rootRequestHandler(req, res, next)

      const sent = res.send.firstCall.args[0]
      expect(sent).to.not.include('<b>')
      expect(sent).to.include('&lt;b&gt;')
    })

    it('HTML-escapes the relay URL', () => {
      createSettingsStub.returns({
        ...baseSettings,
        info: { ...baseSettings.info, relay_url: 'wss://relay.example.com?a=1&b=2' },
      })
      getTemplateStub.returns('{{relay_url}}')

      rootRequestHandler(req, res, next)

      const sent = res.send.firstCall.args[0]
      expect(sent).to.include('&amp;')
    })

    it('injects the CSP nonce', () => {
      createSettingsStub.returns(baseSettings)
      getTemplateStub.returns('{{nonce}}')

      rootRequestHandler(req, res, next)

      expect(res.send.firstCall.args[0]).to.equal('test-nonce')
    })

    it('shows amount in sats when admission fee is enabled', () => {
      createSettingsStub.returns(settingsWithFee)
      getTemplateStub.returns('{{amount}}')

      rootRequestHandler(req, res, next)

      // 21000 msats → 21 sats
      expect(res.send.firstCall.args[0]).to.equal('21')
    })

    it('shows 0 amount when payments are disabled', () => {
      createSettingsStub.returns(baseSettings)
      getTemplateStub.returns('{{amount}}')

      rootRequestHandler(req, res, next)

      expect(res.send.firstCall.args[0]).to.equal('0')
    })

    it('sets payments_section_class to d-none when fee is disabled', () => {
      createSettingsStub.returns(baseSettings)
      getTemplateStub.returns('{{payments_section_class}}')

      rootRequestHandler(req, res, next)

      expect(res.send.firstCall.args[0]).to.equal('d-none')
    })

    it('sets payments_section_class to empty string when fee is enabled', () => {
      createSettingsStub.returns(settingsWithFee)
      getTemplateStub.returns('{{payments_section_class}}')

      rootRequestHandler(req, res, next)

      expect(res.send.firstCall.args[0]).to.equal('')
    })

    it('calls next with error when template read fails', () => {
      createSettingsStub.returns(baseSettings)
      const err = new Error('file not found')
      getTemplateStub.throws(err)

      rootRequestHandler(req, res, next)

      expect(next).to.have.been.calledWith(err)
      expect(res.send).to.not.have.been.called
    })
  })
})
