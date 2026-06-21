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
import { hmacSha256 } from '../../../../src/utils/secret'
import { OpenNodeCallbackController } from '../../../../src/controllers/callbacks/opennode-callback-controller'

const PUBKEY = 'a'.repeat(64)

const baseSettings: any = {
  payments: { processor: 'opennode' },
}

const makeRes = (): any => ({
  status: sinon.stub().returnsThis(),
  setHeader: sinon.stub().returnsThis(),
  send: sinon.stub().returnsThis(),
})

const makeInvoice = (overrides: any = {}) => ({
  id: 'opennode-invoice-id',
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

const makeBody = (overrides: any = {}) => {
  const id = overrides.id ?? 'opennode-invoice-id'
  const openNodeApiKey = process.env.OPENNODE_API_KEY as string

  return {
    id,
    status: 'paid',
    hashed_order: hmacSha256(openNodeApiKey, id).toString('hex'),
    ...overrides,
  }
}

const makeReq = (overrides: any = {}): any => ({
  headers: {},
  body: overrides.body ?? makeBody(),
  ...overrides,
})

describe('OpenNodeCallbackController', () => {
  let createSettingsStub: sinon.SinonStub
  let getRemoteAddressStub: sinon.SinonStub
  let consoleErrorStub: sinon.SinonStub
  let previousOpenNodeApiKey: string | undefined

  beforeEach(() => {
    previousOpenNodeApiKey = process.env.OPENNODE_API_KEY
    process.env.OPENNODE_API_KEY = 'test-api-key'

    createSettingsStub = sinon.stub(settingsFactory, 'createSettings').returns(baseSettings)
    getRemoteAddressStub = sinon.stub(httpUtils, 'getRemoteAddress').returns('1.2.3.4')
    consoleErrorStub = sinon.stub(console, 'error')
  })

  afterEach(() => {
    if (previousOpenNodeApiKey === undefined) {
      delete process.env.OPENNODE_API_KEY
    } else {
      process.env.OPENNODE_API_KEY = previousOpenNodeApiKey
    }

    createSettingsStub.restore()
    getRemoteAddressStub.restore()
    consoleErrorStub.restore()
  })

  describe('authorization and validation', () => {
    it('returns 400 for malformed request body', async () => {
      const { controller, paymentsService } = makeController()
      const res = makeRes()

      await controller.handleRequest(
        makeReq({ body: { id: 'missing-required-fields' } }),
        res,
      )

      expect(res.status).to.have.been.calledWith(400)
      expect(res.setHeader).to.have.been.calledWith('content-type', 'text/plain; charset=utf8')
      expect(res.send).to.have.been.calledWith('Malformed body')
      expect(paymentsService.updateInvoiceStatus).to.not.have.been.called
    })

    it('returns 400 for unknown status values', async () => {
      const { controller, paymentsService } = makeController()
      const res = makeRes()

      await controller.handleRequest(
        makeReq({ body: makeBody({ status: 'totally_made_up' }) }),
        res,
      )

      expect(res.status).to.have.been.calledWith(400)
      expect(res.send).to.have.been.calledWith('Malformed body')
      expect(paymentsService.updateInvoiceStatus).to.not.have.been.called
    })

    it('returns 500 when OPENNODE_API_KEY is missing', async () => {
      const { controller, paymentsService } = makeController()
      const res = makeRes()

      delete process.env.OPENNODE_API_KEY

      await controller.handleRequest(
        makeReq({
          body: {
            hashed_order: 'some-hash',
            id: 'invoice-id',
            status: 'paid',
          },
        }),
        res,
      )

      expect(res.status).to.have.been.calledWith(500)
      expect(res.setHeader).to.have.been.calledWith('content-type', 'text/plain; charset=utf8')
      expect(res.send).to.have.been.calledWith('Internal Server Error')
      expect(paymentsService.updateInvoiceStatus).to.not.have.been.called
    })

    it('returns 400 for malformed hashed_order', async () => {
      const { controller, paymentsService } = makeController()
      const res = makeRes()

      await controller.handleRequest(
        makeReq({ body: makeBody({ hashed_order: 'invalid' }) }),
        res,
      )

      expect(res.status).to.have.been.calledWith(400)
      expect(res.setHeader).to.have.been.calledWith('content-type', 'text/plain; charset=utf8')
      expect(res.send).to.have.been.calledWith('Bad Request')
      expect(paymentsService.updateInvoiceStatus).to.not.have.been.called
    })

    it('returns 403 for mismatched hashed_order', async () => {
      const { controller, paymentsService } = makeController()
      const res = makeRes()

      await controller.handleRequest(
        makeReq({ body: makeBody({ hashed_order: '0'.repeat(64) }) }),
        res,
      )

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

      await controller.handleRequest(
        makeReq({ body: makeBody({ status: 'processing' }) }),
        res,
      )

      expect(res.status).to.have.been.calledWith(200)
      expect(paymentsService.confirmInvoice).to.not.have.been.called
      expect(paymentsService.sendInvoiceUpdateNotification).to.not.have.been.called
    })

    it('confirms and notifies for completed invoices', async () => {
      const paymentsService = {
        updateInvoiceStatus: sinon.stub().resolves(makeInvoice({
          confirmedAt: null,
          status: InvoiceStatus.COMPLETED,
        })),
        confirmInvoice: sinon.stub().resolves(),
        sendInvoiceUpdateNotification: sinon.stub().resolves(),
      }
      const { controller } = makeController({ paymentsService })
      const res = makeRes()

      await controller.handleRequest(makeReq(), res)

      expect(paymentsService.confirmInvoice).to.have.been.calledOnce
      expect(paymentsService.sendInvoiceUpdateNotification).to.have.been.calledOnce

      expect(paymentsService.confirmInvoice).to.have.been.calledWithMatch({
        amountPaid: 21n,
        id: 'opennode-invoice-id',
        pubkey: PUBKEY,
        status: InvoiceStatus.COMPLETED,
      })
      const confirmedAtArg = paymentsService.confirmInvoice.firstCall.args[0].confirmedAt
      expect(confirmedAtArg).to.be.instanceOf(Date)

      expect(res.status).to.have.been.calledWith(200)
      expect(res.setHeader).to.have.been.calledWith('content-type', 'text/plain; charset=utf8')
      expect(res.send).to.have.been.calledWith('OK')
    })
  })

  describe('error propagation', () => {
    it('rejects when invoice status update fails', async () => {
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
