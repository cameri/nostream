import chai from 'chai'
import chaiAsPromised from 'chai-as-promised'
import sinon from 'sinon'
import sinonChai from 'sinon-chai'

chai.use(sinonChai)
chai.use(chaiAsPromised)
const { expect } = chai

import * as httpUtils from '../../../../src/utils/http'
import * as settingsFactory from '../../../../src/factories/settings-factory'
import { deriveFromSecret, hmacSha256 } from '../../../../src/utils/secret'
import { InvoiceStatus, InvoiceUnit } from '../../../../src/@types/invoice'
import { LNbitsCallbackController } from '../../../../src/controllers/callbacks/lnbits-callback-controller'

const PAYMENT_HASH = 'a'.repeat(64)
const PUBKEY = 'b'.repeat(64)
const VALID_HMAC_EXPIRY = Date.parse('2100-01-01T00:00:00.000Z')

const baseSettings: any = {
  payments: { processor: 'lnbits' },
  network: { remoteIpHeader: 'x-forwarded-for' },
}

const makeRes = (): any => ({
  status: sinon.stub().returnsThis(),
  setHeader: sinon.stub().returnsThis(),
  send: sinon.stub().returnsThis(),
})

const makeInvoice = (overrides: any = {}) => ({
  id: PAYMENT_HASH,
  pubkey: PUBKEY,
  bolt11: 'lnbc210n1test',
  amountRequested: 21000n,
  unit: InvoiceUnit.MSATS,
  status: InvoiceStatus.COMPLETED,
  description: 'test invoice',
  confirmedAt: new Date('2030-01-01T00:00:00.000Z'),
  expiresAt: new Date('2030-01-01T00:15:00.000Z'),
  updatedAt: new Date('2030-01-01T00:00:00.000Z'),
  createdAt: new Date('2030-01-01T00:00:00.000Z'),
  ...overrides,
})

const makeController = (overrides: { paymentsService?: any; invoiceRepository?: any } = {}) => {
  const paymentsService = overrides.paymentsService ?? {
    getInvoiceFromPaymentsProcessor: sinon.stub().resolves(makeInvoice()),
    updateInvoice: sinon.stub().resolves(),
    confirmInvoice: sinon.stub().resolves(),
    sendInvoiceUpdateNotification: sinon.stub().resolves(),
  }
  const invoiceRepository = overrides.invoiceRepository ?? {
    findById: sinon.stub().resolves(makeInvoice({ status: InvoiceStatus.PENDING })),
  }

  return {
    controller: new LNbitsCallbackController(paymentsService, invoiceRepository),
    paymentsService,
    invoiceRepository,
  }
}

const makeValidQuery = (expiry = VALID_HMAC_EXPIRY) => {
  const expiryString = String(expiry)
  const signature = hmacSha256(deriveFromSecret('lnbits-callback-hmac-key'), expiryString).toString('hex')

  return { hmac: `${expiryString}:${signature}` }
}

const makeReq = (overrides: any = {}): any => ({
  headers: {},
  query: makeValidQuery(),
  body: { payment_hash: PAYMENT_HASH },
  socket: { remoteAddress: '1.2.3.4' },
  ...overrides,
})

describe('LNbitsCallbackController', () => {
  let createSettingsStub: sinon.SinonStub
  let getRemoteAddressStub: sinon.SinonStub
  let consoleErrorStub: sinon.SinonStub
  let clock: sinon.SinonFakeTimers
  let previousSecret: string | undefined

  beforeEach(() => {
    previousSecret = process.env.SECRET
    process.env.SECRET = 'unit-test-secret'

    clock = sinon.useFakeTimers(1600000000000)

    createSettingsStub = sinon.stub(settingsFactory, 'createSettings').returns(baseSettings)
    getRemoteAddressStub = sinon.stub(httpUtils, 'getRemoteAddress').returns('1.2.3.4')
    consoleErrorStub = sinon.stub(console, 'error')
  })

  afterEach(() => {
    if (previousSecret === undefined) {
      delete process.env.SECRET
    } else {
      process.env.SECRET = previousSecret
    }

    clock.restore()
    createSettingsStub.restore()
    getRemoteAddressStub.restore()
    consoleErrorStub.restore()
  })

  describe('authorization and validation', () => {
    it('returns 403 for invalid query parameters', async () => {
      const { controller } = makeController()
      const res = makeRes()

      await controller.handleRequest(makeReq({ query: {} }), res)

      expect(res.status).to.have.been.calledWith(403)
      expect(res.send).to.have.been.calledWith('Forbidden')
    })

    it('returns 403 when the hmac signature does not match', async () => {
      const { controller } = makeController()
      const res = makeRes()
      const validQuery = makeValidQuery()
      const [expiryString] = validQuery.hmac.split(':')

      await controller.handleRequest(makeReq({ query: { hmac: `${expiryString}:${'c'.repeat(64)}` } }), res)

      expect(res.status).to.have.been.calledWith(403)
      expect(res.send).to.have.been.calledWith('Forbidden')
    })

    it('returns 403 when the hmac expiry is not a safe integer', async () => {
      const { controller } = makeController()
      const res = makeRes()
      const unsafeExpiry = '9007199254740993'
      const signature = hmacSha256(deriveFromSecret('lnbits-callback-hmac-key'), unsafeExpiry).toString('hex')

      await controller.handleRequest(makeReq({ query: { hmac: `${unsafeExpiry}:${signature}` } }), res)

      expect(res.status).to.have.been.calledWith(403)
      expect(res.send).to.have.been.calledWith('Forbidden')
    })

    it('returns 403 when the hmac has expired', async () => {
      const { controller } = makeController()
      const res = makeRes()

      await controller.handleRequest(makeReq({ query: makeValidQuery(Date.now() - 60_000) }), res)

      expect(res.status).to.have.been.calledWith(403)
      expect(res.send).to.have.been.calledWith('Forbidden')
    })

    it('returns 400 for an invalid callback body', async () => {
      const { controller } = makeController()
      const res = makeRes()

      await controller.handleRequest(makeReq({ body: { invalid: true } }), res)

      expect(res.status).to.have.been.calledWith(400)
      expect(res.setHeader).to.have.been.calledWith('content-type', 'text/plain; charset=utf8')
      expect(res.send).to.have.been.calledWith('Malformed body')
    })
  })

  describe('invoice state handling', () => {
    it('returns 404 when invoice is not found in repository', async () => {
      const invoiceRepository = {
        findById: sinon.stub().resolves(undefined),
      }
      const { controller } = makeController({ invoiceRepository })
      const res = makeRes()

      await controller.handleRequest(makeReq(), res)

      expect(res.status).to.have.been.calledWith(404)
      expect(res.send).to.have.been.calledWith('No such invoice')
    })

    it('returns 200 without confirmation when processor invoice is still pending', async () => {
      const paymentsService = {
        getInvoiceFromPaymentsProcessor: sinon.stub().resolves(
          makeInvoice({
            status: InvoiceStatus.PENDING,
            confirmedAt: null,
          }),
        ),
        updateInvoice: sinon.stub().resolves(),
        confirmInvoice: sinon.stub().resolves(),
        sendInvoiceUpdateNotification: sinon.stub().resolves(),
      }
      const { controller } = makeController({ paymentsService })
      const res = makeRes()

      await controller.handleRequest(makeReq(), res)

      expect(res.status).to.have.been.calledWith(200)
      expect(paymentsService.confirmInvoice).to.not.have.been.called
      expect(paymentsService.sendInvoiceUpdateNotification).to.not.have.been.called
    })

    it('returns 409 when invoice is already marked completed in storage', async () => {
      const invoiceRepository = {
        findById: sinon.stub().resolves(makeInvoice({ status: InvoiceStatus.COMPLETED })),
      }
      const { controller } = makeController({ invoiceRepository })
      const res = makeRes()

      await controller.handleRequest(makeReq(), res)

      expect(res.status).to.have.been.calledWith(409)
      expect(res.send).to.have.been.calledWith('Invoice is already marked paid')
    })

    it('confirms and notifies when invoice transitions to completed', async () => {
      const paymentsService = {
        getInvoiceFromPaymentsProcessor: sinon.stub().resolves(makeInvoice({ status: InvoiceStatus.COMPLETED })),
        updateInvoice: sinon.stub().resolves(),
        confirmInvoice: sinon.stub().resolves(),
        sendInvoiceUpdateNotification: sinon.stub().resolves(),
      }
      const invoiceRepository = {
        findById: sinon.stub().resolves(makeInvoice({ status: InvoiceStatus.PENDING })),
      }
      const { controller } = makeController({ paymentsService, invoiceRepository })
      const res = makeRes()

      await controller.handleRequest(makeReq(), res)

      expect(paymentsService.confirmInvoice).to.have.been.calledOnce
      expect(paymentsService.sendInvoiceUpdateNotification).to.have.been.calledOnce

      const invoice = paymentsService.confirmInvoice.firstCall.args[0]
      expect(invoice.amountPaid).to.equal(invoice.amountRequested)

      expect(res.status).to.have.been.calledWith(200)
      expect(res.setHeader).to.have.been.calledWith('content-type', 'text/plain; charset=utf8')
      expect(res.send).to.have.been.calledWith('OK')
    })
  })

  describe('error propagation', () => {
    it('rejects when invoice update fails', async () => {
      const updateError = new Error('database unavailable')
      const paymentsService = {
        getInvoiceFromPaymentsProcessor: sinon.stub().resolves(makeInvoice()),
        updateInvoice: sinon.stub().rejects(updateError),
        confirmInvoice: sinon.stub().resolves(),
        sendInvoiceUpdateNotification: sinon.stub().resolves(),
      }
      const { controller } = makeController({ paymentsService })

      await expect(controller.handleRequest(makeReq(), makeRes())).to.eventually.be.rejectedWith(updateError)
    })

    it('rejects when invoice confirmation fails', async () => {
      const confirmError = new Error('cannot confirm invoice')
      const paymentsService = {
        getInvoiceFromPaymentsProcessor: sinon.stub().resolves(makeInvoice()),
        updateInvoice: sinon.stub().resolves(),
        confirmInvoice: sinon.stub().rejects(confirmError),
        sendInvoiceUpdateNotification: sinon.stub().resolves(),
      }
      const { controller } = makeController({ paymentsService })

      await expect(controller.handleRequest(makeReq(), makeRes())).to.eventually.be.rejectedWith(confirmError)
    })
  })
})
