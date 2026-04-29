import chai from 'chai'
import chaiAsPromised from 'chai-as-promised'
import sinon from 'sinon'
import sinonChai from 'sinon-chai'

chai.use(sinonChai)
chai.use(chaiAsPromised)
const { expect } = chai

import { InvoiceStatus, InvoiceUnit } from '../../../../src/@types/invoice'
import { hmacSha256 } from '../../../../src/utils/secret'
import { NodelessCallbackController } from '../../../../src/controllers/callbacks/nodeless-callback-controller'

const PUBKEY = 'a'.repeat(64)

const validBody = {
  uuid: 'nodeless-invoice-id',
  status: 'paid',
  amount: 42,
  metadata: {
    requestId: PUBKEY,
    description: 'Nodeless callback',
    unit: 'sats',
    createdAt: '2030-01-01T00:00:00.000Z',
  },
}

const makeRes = (): any => ({
  status: sinon.stub().returnsThis(),
  setHeader: sinon.stub().returnsThis(),
  send: sinon.stub().returnsThis(),
})

const makeInvoice = (overrides: any = {}) => ({
  id: validBody.uuid,
  pubkey: PUBKEY,
  bolt11: 'lnbc42n1test',
  amountRequested: 42n,
  unit: InvoiceUnit.SATS,
  status: InvoiceStatus.COMPLETED,
  description: 'Nodeless callback',
  confirmedAt: new Date('2030-01-01T00:01:00.000Z'),
  expiresAt: new Date('2030-01-01T00:15:00.000Z'),
  updatedAt: new Date('2030-01-01T00:01:00.000Z'),
  createdAt: new Date('2030-01-01T00:00:00.000Z'),
  ...overrides,
})

const makeController = (overrides: { paymentsService?: any } = {}) => {
  const paymentsService = overrides.paymentsService ?? {
    updateInvoiceStatus: sinon.stub().resolves(makeInvoice()),
    confirmInvoice: sinon.stub().resolves(),
    sendInvoiceUpdateNotification: sinon.stub().resolves(),
  }

  return {
    controller: new NodelessCallbackController(paymentsService),
    paymentsService,
  }
}

const makeSignature = (rawBody: Buffer) =>
  hmacSha256(process.env.NODELESS_WEBHOOK_SECRET as string, rawBody).toString('hex')

const makeReq = (overrides: any = {}): any => {
  const body = overrides.body ?? validBody
  const rawBody = overrides.rawBody ?? Buffer.from(JSON.stringify(body))
  const signature = overrides.signature ?? makeSignature(rawBody)

  return {
    headers: {
      'nodeless-signature': signature,
      ...(overrides.headers ?? {}),
    },
    body,
    rawBody,
    ...overrides,
  }
}

describe('NodelessCallbackController', () => {
  let consoleErrorStub: sinon.SinonStub
  let previousWebhookSecret: string | undefined

  beforeEach(() => {
    previousWebhookSecret = process.env.NODELESS_WEBHOOK_SECRET
    process.env.NODELESS_WEBHOOK_SECRET = 'nodeless-test-secret'

    consoleErrorStub = sinon.stub(console, 'error')
  })

  afterEach(() => {
    if (previousWebhookSecret === undefined) {
      delete process.env.NODELESS_WEBHOOK_SECRET
    } else {
      process.env.NODELESS_WEBHOOK_SECRET = previousWebhookSecret
    }

    consoleErrorStub.restore()
  })

  describe('authorization and validation', () => {
    it('returns 400 for malformed request body', async () => {
      const { controller } = makeController()
      const res = makeRes()

      await controller.handleRequest(makeReq({ body: { uuid: 'missing-required-fields' } }), res)

      expect(res.status).to.have.been.calledWith(400)
      expect(res.setHeader).to.have.been.calledWith('content-type', 'application/json; charset=utf8')
      expect(res.send).to.have.been.calledWith('{"status":"error","message":"Malformed body"}')
    })

    it('returns 400 when callback signature has invalid format', async () => {
      const { controller, paymentsService } = makeController()
      const res = makeRes()

      await controller.handleRequest(makeReq({ signature: 'invalid-signature' }), res)

      expect(res.status).to.have.been.calledWith(400)
      expect(res.send).to.have.been.calledWith('{"status":"error","message":"Invalid signature"}')
      expect(paymentsService.updateInvoiceStatus).to.not.have.been.called
    })

    it('returns 400 when callback signature has wrong length', async () => {
      const { controller, paymentsService } = makeController()
      const res = makeRes()

      await controller.handleRequest(makeReq({ signature: '0'.repeat(63) }), res)

      expect(res.status).to.have.been.calledWith(400)
      expect(res.send).to.have.been.calledWith('{"status":"error","message":"Invalid signature"}')
      expect(paymentsService.updateInvoiceStatus).to.not.have.been.called
    })

    it('returns 403 when callback signature is a valid-length hex string but does not match', async () => {
      const { controller, paymentsService } = makeController()
      const res = makeRes()

      await controller.handleRequest(makeReq({ signature: '0'.repeat(64) }), res)

      expect(res.status).to.have.been.calledWith(403)
      expect(res.send).to.have.been.calledWith('Forbidden')
      expect(paymentsService.updateInvoiceStatus).to.not.have.been.called
    })

    it('returns 500 when NODELESS_WEBHOOK_SECRET is not configured', async () => {
      delete process.env.NODELESS_WEBHOOK_SECRET
      const { controller, paymentsService } = makeController()
      const res = makeRes()
      const rawBody = Buffer.from(JSON.stringify(validBody))
      const req = {
        headers: { 'nodeless-signature': 'does-not-matter' },
        body: validBody,
        rawBody,
      }

      await controller.handleRequest(req as any, res)

      expect(res.status).to.have.been.calledWith(500)
      expect(res.setHeader).to.have.been.calledWith('content-type', 'application/json; charset=utf8')
      expect(res.send).to.have.been.calledWith('{"status":"error","message":"Internal Server Error"}')
      expect(paymentsService.updateInvoiceStatus).to.not.have.been.called
    })

  })

  describe('invoice state handling', () => {
    it('returns 200 without confirmation when invoice is not completed', async () => {
      const paymentsService = {
        updateInvoiceStatus: sinon.stub().resolves(
          makeInvoice({
            status: InvoiceStatus.PENDING,
            confirmedAt: null,
          }),
        ),
        confirmInvoice: sinon.stub().resolves(),
        sendInvoiceUpdateNotification: sinon.stub().resolves(),
      }
      const { controller } = makeController({ paymentsService })
      const res = makeRes()

      await controller.handleRequest(makeReq({ body: { ...validBody, status: 'new' } }), res)

      expect(res.status).to.have.been.calledWith(200)
      expect(paymentsService.confirmInvoice).to.not.have.been.called
      expect(paymentsService.sendInvoiceUpdateNotification).to.not.have.been.called
    })

    it('updates, confirms, and notifies when invoice is completed', async () => {
      const paymentsService = {
        updateInvoiceStatus: sinon.stub().resolves(makeInvoice({ status: InvoiceStatus.COMPLETED })),
        confirmInvoice: sinon.stub().resolves(),
        sendInvoiceUpdateNotification: sinon.stub().resolves(),
      }
      const { controller } = makeController({ paymentsService })
      const res = makeRes()

      await controller.handleRequest(makeReq(), res)

      const updateArg = paymentsService.updateInvoiceStatus.firstCall.args[0]
      expect(updateArg.id).to.equal(validBody.uuid)
      expect(updateArg.pubkey).to.equal(PUBKEY)
      expect(updateArg.amountRequested).to.equal(42n)

      expect(paymentsService.confirmInvoice).to.have.been.calledOnce
      expect(paymentsService.sendInvoiceUpdateNotification).to.have.been.calledOnce

      expect(res.status).to.have.been.calledWith(200)
      expect(res.setHeader).to.have.been.calledWith('content-type', 'application/json; charset=utf8')
      expect(res.send).to.have.been.calledWith('{"status":"ok"}')
    })
  })

  describe('error propagation', () => {
    it('rejects when invoice persistence fails', async () => {
      const updateError = new Error('update failed')
      const paymentsService = {
        updateInvoiceStatus: sinon.stub().rejects(updateError),
        confirmInvoice: sinon.stub().resolves(),
        sendInvoiceUpdateNotification: sinon.stub().resolves(),
      }
      const { controller } = makeController({ paymentsService })

      await expect(controller.handleRequest(makeReq(), makeRes())).to.eventually.be.rejectedWith(updateError)
    })

    it('rejects when invoice confirmation fails', async () => {
      const confirmError = new Error('confirmation failed')
      const paymentsService = {
        updateInvoiceStatus: sinon.stub().resolves(makeInvoice()),
        confirmInvoice: sinon.stub().rejects(confirmError),
        sendInvoiceUpdateNotification: sinon.stub().resolves(),
      }
      const { controller } = makeController({ paymentsService })

      await expect(controller.handleRequest(makeReq(), makeRes())).to.eventually.be.rejectedWith(confirmError)
    })
  })
})
