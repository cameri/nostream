import chai from 'chai'
import chaiAsPromised from 'chai-as-promised'
import sinon from 'sinon'
import sinonChai from 'sinon-chai'

chai.use(sinonChai)
chai.use(chaiAsPromised)
const { expect } = chai

import { InvoiceStatus, InvoiceUnit } from '../../../../src/@types/invoice'
import { OpenNodeCallbackController } from '../../../../src/controllers/callbacks/opennode-callback-controller'

const PUBKEY = 'a'.repeat(64)

const validBody = {
  id: 'opennode-invoice-id',
  status: 'paid',
  order_id: PUBKEY,
  amount: 21,
  created_at: 1672531200,
  lightning_invoice: {
    payreq: 'lnbc210n1test',
    expires_at: 1672532200,
  },
}

const makeRes = (): any => ({
  status: sinon.stub().returnsThis(),
  setHeader: sinon.stub().returnsThis(),
  send: sinon.stub().returnsThis(),
})

const makeInvoice = (overrides: any = {}) => ({
  id: validBody.id,
  pubkey: PUBKEY,
  bolt11: 'lnbc210n1test',
  amountRequested: 21n,
  unit: InvoiceUnit.SATS,
  status: InvoiceStatus.COMPLETED,
  description: '',
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
    controller: new OpenNodeCallbackController(paymentsService),
    paymentsService,
  }
}

const makeReq = (overrides: any = {}): any => ({
  headers: {},
  body: validBody,
  ...overrides,
})

describe('OpenNodeCallbackController', () => {
  let consoleErrorStub: sinon.SinonStub

  beforeEach(() => {
    consoleErrorStub = sinon.stub(console, 'error')
  })

  afterEach(() => {
    consoleErrorStub.restore()
  })

  describe('validation', () => {
    it('returns 400 for malformed request body', async () => {
      const { controller } = makeController()
      const res = makeRes()

      await controller.handleRequest(makeReq({ body: { id: 'missing-order-id' } }), res)

      expect(res.status).to.have.been.calledWith(400)
      expect(res.setHeader).to.have.been.calledWith('content-type', 'text/plain; charset=utf8')
      expect(res.send).to.have.been.calledWith('Malformed body')
    })
  })

  describe('invoice state handling', () => {
    it('returns 200 without confirmation for pending invoices', async () => {
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

      await controller.handleRequest(makeReq({ body: { ...validBody, status: 'processing' } }), res)

      expect(res.status).to.have.been.calledWith(200)
      expect(paymentsService.confirmInvoice).to.not.have.been.called
      expect(paymentsService.sendInvoiceUpdateNotification).to.not.have.been.called
    })

    it('confirms and notifies for completed invoices', async () => {
      const paymentsService = {
        updateInvoiceStatus: sinon.stub().resolves(makeInvoice({ status: InvoiceStatus.COMPLETED })),
        confirmInvoice: sinon.stub().resolves(),
        sendInvoiceUpdateNotification: sinon.stub().resolves(),
      }
      const { controller } = makeController({ paymentsService })
      const res = makeRes()

      await controller.handleRequest(makeReq(), res)

      expect(paymentsService.confirmInvoice).to.have.been.calledOnce
      expect(paymentsService.sendInvoiceUpdateNotification).to.have.been.calledOnce

      expect(paymentsService.confirmInvoice).to.have.been.calledWithMatch({
        id: validBody.id,
        pubkey: PUBKEY,
        status: InvoiceStatus.COMPLETED,
        amountPaid: 21n,
      })

      expect(res.status).to.have.been.calledWith(200)
      expect(res.setHeader).to.have.been.calledWith('content-type', 'text/plain; charset=utf8')
      expect(res.send).to.have.been.calledWith('OK')
    })
  })

  describe('error propagation', () => {
    it('rejects when status update fails', async () => {
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
      const confirmError = new Error('confirm failed')
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
