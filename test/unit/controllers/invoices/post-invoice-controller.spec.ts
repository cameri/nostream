import chai from 'chai'
import chaiAsPromised from 'chai-as-promised'
import sinon from 'sinon'
import sinonChai from 'sinon-chai'

chai.use(sinonChai)
chai.use(chaiAsPromised)
const { expect } = chai

import * as eventUtils from '../../../../src/utils/event'
import * as templateCache from '../../../../src/utils/template-cache'
import { PostInvoiceController } from '../../../../src/controllers/invoices/post-invoice-controller'

const VALID_PUBKEY = 'a'.repeat(64)

const baseSettings = {
  info: {
    name: 'Test Relay',
    relay_url: 'wss://relay.example.com',
  },
  payments: {
    enabled: true,
    processor: 'lnbits',
    feeSchedules: {
      admission: [{ enabled: true, amount: 21000, whitelists: {} }],
    },
  },
  limits: {},
  network: {
    remoteIpHeader: 'x-forwarded-for',
  },
}

const makeController = (
  overrides: { settings?: () => any; userRepository?: any; paymentsService?: any; rateLimiter?: any } = {},
) => {
  return new PostInvoiceController(
    overrides.userRepository ?? { findByPubkey: sinon.stub().resolves(null) },
    overrides.paymentsService ?? {
      createInvoice: sinon.stub().resolves({
        id: 'inv-ref-123',
        bolt11: 'lnbc210n1...',
        expiresAt: new Date('2030-01-01T00:00:00Z'),
      }),
    },
    overrides.settings ?? (() => baseSettings),
    overrides.rateLimiter ?? (() => ({ hit: sinon.stub().resolves(false) })),
  )
}

const makeRes = (): any => ({
  status: sinon.stub().returnsThis(),
  setHeader: sinon.stub().returnsThis(),
  send: sinon.stub().returnsThis(),
  locals: { nonce: 'post-inv-nonce' },
})

const validBody = {
  tosAccepted: 'yes',
  feeSchedule: 'admission',
  pubkey: VALID_PUBKEY,
}

describe('PostInvoiceController', () => {
  let getTemplateStub: sinon.SinonStub
  let getRelayPrivateKeyStub: sinon.SinonStub
  let getPublicKeyStub: sinon.SinonStub

  beforeEach(() => {
    getTemplateStub = sinon.stub(templateCache, 'getTemplate').returns('{{name}}|{{nonce}}')
    getRelayPrivateKeyStub = sinon.stub(eventUtils, 'getRelayPrivateKey').returns('a'.repeat(64))
    getPublicKeyStub = sinon.stub(eventUtils, 'getPublicKey').returns('b'.repeat(64))
  })

  afterEach(() => {
    getTemplateStub.restore()
    getRelayPrivateKeyStub.restore()
    getPublicKeyStub.restore()
  })

  describe('rate limiting', () => {
    it('returns 429 when rate limited', async () => {
      const rateLimiter = { hit: sinon.stub().resolves(true) }
      const settings = () => ({
        ...baseSettings,
        limits: {
          invoice: {
            rateLimits: [{ rate: 2, period: 60000 }],
            ipWhitelist: [],
          },
        },
      })
      const controller = makeController({ settings, rateLimiter: () => rateLimiter })
      const res = makeRes()
      const req: any = {
        params: {},
        body: validBody,
        headers: {},
        connection: { remoteAddress: '1.2.3.4' },
        socket: { remoteAddress: '1.2.3.4' },
      }

      await controller.handleRequest(req, res)

      expect(res.status).to.have.been.calledWith(429)
    })
  })

  describe('request validation', () => {
    it('returns 400 for missing body', async () => {
      const controller = makeController()
      const res = makeRes()

      await controller.handleRequest({ body: null } as any, res)

      expect(res.status).to.have.been.calledWith(400)
    })

    it('returns 400 for non-object body', async () => {
      const controller = makeController()
      const res = makeRes()

      await controller.handleRequest({ body: 'string' } as any, res)

      expect(res.status).to.have.been.calledWith(400)
    })

    it('returns 400 when ToS not accepted', async () => {
      const controller = makeController()
      const res = makeRes()

      await controller.handleRequest({ body: { ...validBody, tosAccepted: 'no' } } as any, res)

      expect(res.status).to.have.been.calledWith(400)
      expect(res.send).to.have.been.calledWith('ToS agreement: not accepted')
    })

    it('returns 400 for non-admission feeSchedule', async () => {
      const controller = makeController()
      const res = makeRes()

      await controller.handleRequest({ body: { ...validBody, feeSchedule: 'subscription' } } as any, res)

      expect(res.status).to.have.been.calledWith(400)
      expect(res.send).to.have.been.calledWith('Invalid fee')
    })

    it('returns 400 when pubkey is missing', async () => {
      const controller = makeController()
      const res = makeRes()
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { pubkey: _, ...bodyWithoutPubkey } = validBody

      await controller.handleRequest({ body: bodyWithoutPubkey } as any, res)

      expect(res.status).to.have.been.calledWith(400)
      expect(res.send).to.have.been.calledWith('Invalid pubkey: missing')
    })

    it('returns 400 for an invalid npub', async () => {
      const controller = makeController()
      const res = makeRes()

      await controller.handleRequest(
        {
          body: { ...validBody, pubkey: 'npub1invalidvalue' },
        } as any,
        res,
      )

      expect(res.status).to.have.been.calledWith(400)
      expect(res.send).to.have.been.calledWith('Invalid pubkey: invalid npub')
    })

    it('returns 400 for unknown pubkey format', async () => {
      const controller = makeController()
      const res = makeRes()

      await controller.handleRequest(
        {
          body: { ...validBody, pubkey: 'notahexpubkey' },
        } as any,
        res,
      )

      expect(res.status).to.have.been.calledWith(400)
      expect(res.send).to.have.been.calledWith('Invalid pubkey: unknown format')
    })
  })

  describe('business rule validation', () => {
    it('returns 400 when no admission fee is enabled', async () => {
      const settings = () => ({
        ...baseSettings,
        payments: {
          ...baseSettings.payments,
          feeSchedules: {
            admission: [{ enabled: false, amount: 21000, whitelists: {} }],
          },
        },
      })
      const controller = makeController({ settings })
      const res = makeRes()

      await controller.handleRequest({ body: validBody } as any, res)

      expect(res.status).to.have.been.calledWith(400)
      expect(res.send).to.have.been.calledWith('No admission fee required')
    })

    it('returns 400 when user is already admitted', async () => {
      const userRepository = {
        findByPubkey: sinon.stub().resolves({ isAdmitted: true, balance: 99999 }),
      }
      const controller = makeController({ userRepository })
      const res = makeRes()

      await controller.handleRequest({ body: validBody } as any, res)

      expect(res.status).to.have.been.calledWith(400)
      expect(res.send).to.have.been.calledWith('User is already admitted.')
    })
  })

  describe('invoice creation', () => {
    it('returns 500 when the payments service throws', async () => {
      const paymentsService = {
        createInvoice: sinon.stub().rejects(new Error('payment gateway down')),
      }
      const controller = makeController({ paymentsService })
      const res = makeRes()

      await controller.handleRequest({ body: validBody } as any, res)

      expect(res.status).to.have.been.calledWith(500)
    })
  })

  describe('successful response', () => {
    it('responds with 200 and text/html', async () => {
      const controller = makeController()
      const res = makeRes()

      await controller.handleRequest({ body: validBody } as any, res)

      expect(res.status).to.have.been.calledWith(200)
      expect(res.setHeader).to.have.been.calledWith('Content-Type', 'text/html; charset=utf8')
    })

    it('loads the post-invoice.html template', async () => {
      const controller = makeController()
      const res = makeRes()

      await controller.handleRequest({ body: validBody } as any, res)

      expect(getTemplateStub).to.have.been.calledWith('./resources/post-invoice.html')
    })

    it('HTML-escapes the relay name in the output', async () => {
      const settings = () => ({
        ...baseSettings,
        info: { ...baseSettings.info, name: '<b>Relay</b>' },
      })
      getTemplateStub.returns('{{name}}')
      const controller = makeController({ settings })
      const res = makeRes()

      await controller.handleRequest({ body: validBody } as any, res)

      const sent = res.send.firstCall.args[0]
      expect(sent).to.not.include('<b>')
      expect(sent).to.include('&lt;b&gt;')
    })

    it('safe-serializes processor for inline script context', async () => {
      getTemplateStub.returns('{{processor_json}}')
      const controller = makeController()
      const res = makeRes()

      await controller.handleRequest({ body: validBody } as any, res)

      const sent = res.send.firstCall.args[0]
      expect(sent).to.not.include('<')
      expect(JSON.parse(sent)).to.equal('lnbits')
    })

    it('renders amount in sats (msats / 1000)', async () => {
      getTemplateStub.returns('{{amount}}')
      const controller = makeController()
      const res = makeRes()

      await controller.handleRequest({ body: validBody } as any, res)

      // 21000 msats → 21 sats
      expect(res.send.firstCall.args[0]).to.equal('21')
    })

    it('injects the CSP nonce', async () => {
      getTemplateStub.returns('{{nonce}}')
      const controller = makeController()
      const res = makeRes()

      await controller.handleRequest({ body: validBody } as any, res)

      expect(res.send.firstCall.args[0]).to.equal('post-inv-nonce')
    })

    it('leaves no unreplaced template variables in the output', async () => {
      getTemplateStub.returns(
        '{{name}}{{relay_url_html}}{{invoice_html}}{{pubkey_html}}{{path_prefix}}{{amount}}' +
          '{{reference_json}}{{relay_url_json}}{{relay_pubkey_json}}' +
          '{{invoice_json}}{{pubkey_json}}{{expires_at_json}}{{path_prefix_json}}{{processor_json}}{{nonce}}',
      )
      const controller = makeController()
      const res = makeRes()

      await controller.handleRequest({ body: validBody } as any, res)

      const sent = res.send.firstCall.args[0] as string
      expect(sent).to.not.match(/\{\{[^}]+\}\}/)
    })

    it('injects relay_url path prefix into form actions and status polling', async () => {
      getTemplateStub.returns('{{path_prefix}}/invoices|{{path_prefix_json}}')
      const settings = () => ({
        ...baseSettings,
        info: { ...baseSettings.info, relay_url: 'wss://relay.example.com/nostream' },
      })
      const controller = makeController({ settings })
      const res = makeRes()

      await controller.handleRequest(
        {
          body: validBody,
          headers: {},
        } as any,
        res,
      )

      const sent = res.send.firstCall.args[0] as string
      expect(sent).to.equal('/nostream/invoices|"/nostream"')
    })
  })
})
