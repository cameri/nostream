import chai from 'chai'
import sinon from 'sinon'
import sinonChai from 'sinon-chai'

chai.use(sinonChai)
const { expect } = chai

import * as settingsFactory from '../../../../src/factories/settings-factory'
import * as templateCache from '../../../../src/utils/template-cache'
import {
  hasExplicitNostrJsonAcceptHeader,
  rootRequestHandler,
} from '../../../../src/handlers/request-handlers/root-request-handler'
import { DEFAULT_FILTER_LIMIT } from '../../../../src/constants/base'

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

describe('hasExplicitNostrJsonAcceptHeader', () => {
  it('returns true for explicit application/nostr+json', () => {
    expect(hasExplicitNostrJsonAcceptHeader({ headers: { accept: 'application/nostr+json' } } as any)).to.equal(true)
  })

  it('returns false for typical browser Accept header', () => {
    const browserAcceptHeader =
      'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8'

    expect(hasExplicitNostrJsonAcceptHeader({ headers: { accept: browserAcceptHeader } } as any)).to.equal(false)
  })

  it('returns false when q=0 for application/nostr+json', () => {
    expect(hasExplicitNostrJsonAcceptHeader({ headers: { accept: 'application/nostr+json;q=0' } } as any)).to.equal(false)
  })
})

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
        header: (name: string) => (name === 'accept' ? 'application/nostr+json' : undefined),
        headers: { accept: 'application/nostr+json' },
      }
    })

    it('responds with 200 and application/nostr+json content-type', () => {
      rootRequestHandler(req, res, next)

      expect(res.setHeader).to.have.been.calledWith('content-type', 'application/nostr+json')
      expect(res.status).to.have.been.calledWith(200)
    })

    it('sets required NIP-11 CORS headers', () => {
      rootRequestHandler(req, res, next)

      expect(res.setHeader).to.have.been.calledWith('access-control-allow-origin', '*')
      expect(res.setHeader).to.have.been.calledWith('access-control-allow-headers', '*')
      expect(res.setHeader).to.have.been.calledWith('access-control-allow-methods', 'GET, OPTIONS')
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

    it('includes relay_url path prefix in payments_url', () => {
      createSettingsStub.returns({
        ...baseSettings,
        info: { ...baseSettings.info, relay_url: 'wss://relay.example.com/nostream' },
      })

      rootRequestHandler(req, res, next)

      const doc = res.send.firstCall.args[0]
      expect(doc.payments_url).to.equal('https://relay.example.com/nostream/invoices')
    })

    
    it('includes optional NIP-11 fields when configured', () => {
      createSettingsStub.returns({
        ...baseSettings,
        info: {
          ...baseSettings.info,
          banner: 'https://relay.example.com/banner.png',
          icon: 'https://relay.example.com/icon.png',
          self: 'f'.repeat(64),
          terms_of_service: 'https://relay.example.com/terms',
        },
      })

      rootRequestHandler(req, res, next)

      const doc = res.send.firstCall.args[0]
      expect(doc.banner).to.equal('https://relay.example.com/banner.png')
      expect(doc.icon).to.equal('https://relay.example.com/icon.png')
      expect(doc.self).to.equal('f'.repeat(64))
      expect(doc.terms_of_service).to.equal('https://relay.example.com/terms')
    })

    it('does not include optional NIP-11 fields when not configured', () => {
      rootRequestHandler(req, res, next)

      const doc = res.send.firstCall.args[0]
      expect(doc).to.not.have.property('banner')
      expect(doc).to.not.have.property('icon')
      expect(doc).to.not.have.property('self')
      expect(doc).to.not.have.property('terms_of_service')
    })

    it('includes NIP-11 limitation created_at and default_limit fields', () => {
      createSettingsStub.returns({
        ...baseSettings,
        limits: {
          ...baseSettings.limits,
          event: {
            ...baseSettings.limits.event,
            createdAt: {
              maxNegativeDelta: 86400,
              maxPositiveDelta: 300,
            },
          },
        },
      })

      rootRequestHandler(req, res, next)

      const doc = res.send.firstCall.args[0]
      expect(doc.limitation.created_at_lower_limit).to.equal(86400)
      expect(doc.limitation.created_at_upper_limit).to.equal(300)
      expect(doc.limitation.default_limit).to.equal(DEFAULT_FILTER_LIMIT)
    })

    it('sets limitation.restricted_writes based on active write restrictions', () => {
      rootRequestHandler(req, res, next)
      const defaultDoc = res.send.firstCall.args[0]
      expect(defaultDoc.limitation.restricted_writes).to.equal(false)

      res.send.resetHistory()
      createSettingsStub.returns(settingsWithFee)

      rootRequestHandler(req, res, next)

      const restrictedDoc = res.send.firstCall.args[0]
      expect(restrictedDoc.limitation.restricted_writes).to.equal(true)
    })
  })

  describe('when serving HTML', () => {
    let req: any

    beforeEach(() => {
      req = {
        header: (name: string) => (name === 'accept' ? 'text/html' : undefined),
        headers: { accept: 'text/html' },
      }
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

    it('injects relay_url path prefix into links', () => {
      createSettingsStub.returns({
        ...baseSettings,
        info: { ...baseSettings.info, relay_url: 'wss://relay.example.com/nostream' },
      })
      getTemplateStub.returns('{{path_prefix}}/invoices|{{path_prefix}}/terms')

      rootRequestHandler(req, res, next)

      expect(res.send.firstCall.args[0]).to.equal('/nostream/invoices|/nostream/terms')
    })

    it('uses trusted forwarded path prefix over relay_url path', () => {
      createSettingsStub.returns({
        ...baseSettings,
        info: { ...baseSettings.info, relay_url: 'wss://relay.example.com/nostream' },
        network: { ...baseSettings.network, trustedProxies: ['127.0.0.1'] },
      })
      getTemplateStub.returns('{{path_prefix}}/invoices')
      req.headers['x-forwarded-prefix'] = '/proxy'
      req.socket = { remoteAddress: '127.0.0.1' }

      rootRequestHandler(req, res, next)

      expect(res.send.firstCall.args[0]).to.equal('/proxy/invoices')
    })

    it('ignores forwarded path prefix when proxy is not trusted', () => {
      createSettingsStub.returns(baseSettings)
      getTemplateStub.returns('{{path_prefix}}/invoices')
      req.headers['x-forwarded-prefix'] = '/nostream'
      req.socket = { remoteAddress: '127.0.0.1' }

      rootRequestHandler(req, res, next)

      expect(res.send.firstCall.args[0]).to.equal('/invoices')
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
