import chai from 'chai'
import chaiAsPromised from 'chai-as-promised'
import sinon from 'sinon'
import sinonChai from 'sinon-chai'

chai.use(sinonChai)
chai.use(chaiAsPromised)
const { expect } = chai

import * as httpUtils from '../../../../src/utils/http'
import * as settingsFactory from '../../../../src/factories/settings-factory'
import { InvoiceStatus, InvoiceUnit } from '../../../../src/@types/invoice'
import { ZebedeeCallbackController } from '../../../../src/controllers/callbacks/zebedee-callback-controller'

const PUBKEY = 'a'.repeat(64)

const baseSettings: any = {
  payments: { processor: 'zebedee' },
  paymentsProcessors: {
    zebedee: { ipWhitelist: [] },
  },
  network: { remoteIpHeader: 'x-forwarded-for' },
}

const validBody = {
  id: 'zebedee-invoice-id',
  status: 'completed',
  internalId: PUBKEY,
  amount: '1000',
  description: 'Zebedee callback',
  unit: 'msats',
  confirmedAt: '2030-01-01T00:01:00.000Z',
  invoice: {
    request: 'lnbc1zebedeeinvoice',
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
  bolt11: validBody.invoice.request,
  amountRequested: 1000n,
  unit: InvoiceUnit.MSATS,
  status: InvoiceStatus.COMPLETED,
  description: validBody.description,
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
    controller: new ZebedeeCallbackController(paymentsService),
    paymentsService,
  }
}

const makeReq = (overrides: any = {}): any => ({
  headers: {},
  body: validBody,
  socket: { remoteAddress: '1.2.3.4' },
  ...overrides,
})

describe('ZebedeeCallbackController', () => {
  let createSettingsStub: sinon.SinonStub
  let getRemoteAddressStub: sinon.SinonStub
  let consoleErrorStub: sinon.SinonStub

  beforeEach(() => {
    createSettingsStub = sinon.stub(settingsFactory, 'createSettings').returns(baseSettings)
    getRemoteAddressStub = sinon.stub(httpUtils, 'getRemoteAddress').returns('1.2.3.4')
    consoleErrorStub = sinon.stub(console, 'error')
  })

  afterEach(() => {
    createSettingsStub.restore()
    getRemoteAddressStub.restore()
    consoleErrorStub.restore()
  })

  describe('authorization and validation', () => {
    it('allows request when zebedee whitelist settings are missing', async () => {
      createSettingsStub.returns({
        payments: { processor: 'zebedee' },
        network: { remoteIpHeader: 'x-forwarded-for' },
      })
      const { controller, paymentsService } = makeController()
      const res = makeRes()

      await controller.handleRequest(makeReq(), res)

      expect(paymentsService.updateInvoiceStatus).to.have.been.calledOnce
      expect(res.status).to.have.been.calledWith(200)
      expect(res.send).to.have.been.calledWith('OK')
    })

    it('returns 400 for malformed request body', async () => {
      const { controller } = makeController()
      const res = makeRes()

      await controller.handleRequest(makeReq({ body: { id: 'missing-required-fields' } }), res)

      expect(res.status).to.have.been.calledWith(400)
      expect(res.setHeader).to.have.been.calledWith('content-type', 'text/plain; charset=utf8')
      expect(res.send).to.have.been.calledWith('Malformed body')
    })

    it('returns 403 when remote IP is not in whitelist', async () => {
      createSettingsStub.returns({
        ...baseSettings,
        paymentsProcessors: {
          zebedee: { ipWhitelist: ['9.9.9.9'] },
        },
      })
      const { controller, paymentsService } = makeController()
      const res = makeRes()

      await controller.handleRequest(makeReq(), res)

      expect(res.status).to.have.been.calledWith(403)
      expect(res.send).to.have.been.calledWith('Forbidden')
      expect(paymentsService.updateInvoiceStatus).to.not.have.been.called
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

      await controller.handleRequest(makeReq({ body: { ...validBody, status: 'pending' } }), res)

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
        amountPaid: 1000n,
      })

      expect(res.status).to.have.been.calledWith(200)
      expect(res.setHeader).to.have.been.calledWith('content-type', 'text/plain; charset=utf8')
      expect(res.send).to.have.been.calledWith('OK')
    })
  })

  describe('error propagation', () => {
    it('rejects when invoice update fails', async () => {
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
