import chai, { expect } from 'chai'
import Sinon from 'sinon'
import sinonChai from 'sinon-chai'

import * as httpUtils from '../../../../src/utils/http'
import * as settingsFactory from '../../../../src/factories/settings-factory'

import { hmacSha256 } from '../../../../src/utils/secret'
import { InvoiceStatus } from '../../../../src/@types/invoice'
import { OpenNodeCallbackController } from '../../../../src/controllers/callbacks/opennode-callback-controller'

chai.use(sinonChai)

describe('OpenNodeCallbackController', () => {
  let createSettingsStub: Sinon.SinonStub
  let getRemoteAddressStub: Sinon.SinonStub
  let updateInvoiceStatusStub: Sinon.SinonStub
  let confirmInvoiceStub: Sinon.SinonStub
  let sendInvoiceUpdateNotificationStub: Sinon.SinonStub
  let statusStub: Sinon.SinonStub
  let setHeaderStub: Sinon.SinonStub
  let sendStub: Sinon.SinonStub
  let controller: OpenNodeCallbackController
  let request: any
  let response: any
  let previousOpenNodeApiKey: string | undefined

  beforeEach(() => {
    previousOpenNodeApiKey = process.env.OPENNODE_API_KEY
    process.env.OPENNODE_API_KEY = 'test-api-key'

    createSettingsStub = Sinon.stub(settingsFactory, 'createSettings').returns({
      payments: { processor: 'opennode' },
    } as any)
    getRemoteAddressStub = Sinon.stub(httpUtils, 'getRemoteAddress').returns('127.0.0.1')

    updateInvoiceStatusStub = Sinon.stub()
    confirmInvoiceStub = Sinon.stub()
    sendInvoiceUpdateNotificationStub = Sinon.stub()

    controller = new OpenNodeCallbackController({
      updateInvoiceStatus: updateInvoiceStatusStub,
      confirmInvoice: confirmInvoiceStub,
      sendInvoiceUpdateNotification: sendInvoiceUpdateNotificationStub,
    } as any)

    statusStub = Sinon.stub()
    setHeaderStub = Sinon.stub()
    sendStub = Sinon.stub()

    response = {
      send: sendStub,
      setHeader: setHeaderStub,
      status: statusStub,
    }

    statusStub.returns(response)
    setHeaderStub.returns(response)
    sendStub.returns(response)

    request = {
      body: {},
      headers: {},
    }
  })

  afterEach(() => {
    getRemoteAddressStub.restore()
    createSettingsStub.restore()

    if (typeof previousOpenNodeApiKey === 'undefined') {
      delete process.env.OPENNODE_API_KEY
    } else {
      process.env.OPENNODE_API_KEY = previousOpenNodeApiKey
    }
  })

  it('rejects requests when OpenNode is not the configured payment processor', async () => {
    createSettingsStub.returns({
      payments: { processor: 'lnbits' },
    } as any)

    await controller.handleRequest(request, response)

    expect(statusStub).to.have.been.calledOnceWithExactly(403)
    expect(sendStub).to.have.been.calledOnceWithExactly('Forbidden')
    expect(updateInvoiceStatusStub).not.to.have.been.called
  })

  it('returns malformed body for invalid callback bodies', async () => {
    request.body = {
      id: 'invoice-id',
    }

    await controller.handleRequest(request, response)

    expect(statusStub).to.have.been.calledOnceWithExactly(400)
    expect(setHeaderStub).to.have.been.calledOnceWithExactly('content-type', 'text/plain; charset=utf8')
    expect(sendStub).to.have.been.calledOnceWithExactly('Malformed body')
    expect(updateInvoiceStatusStub).not.to.have.been.called
  })

  it('returns malformed body for unknown status values', async () => {
    request.body = {
      hashed_order: 'some-hash',
      id: 'invoice-id',
      status: 'totally_made_up',
    }

    await controller.handleRequest(request, response)

    expect(statusStub).to.have.been.calledOnceWithExactly(400)
    expect(sendStub).to.have.been.calledOnceWithExactly('Malformed body')
    expect(updateInvoiceStatusStub).not.to.have.been.called
  })

  it('returns internal server error when OPENNODE_API_KEY is missing', async () => {
    delete process.env.OPENNODE_API_KEY
    request.body = {
      hashed_order: 'some-hash',
      id: 'invoice-id',
      status: 'paid',
    }

    await controller.handleRequest(request, response)

    expect(statusStub).to.have.been.calledOnceWithExactly(500)
    expect(setHeaderStub).to.have.been.calledOnceWithExactly('content-type', 'text/plain; charset=utf8')
    expect(sendStub).to.have.been.calledOnceWithExactly('Internal Server Error')
    expect(updateInvoiceStatusStub).not.to.have.been.called
  })

  it('returns bad request for malformed hashed_order', async () => {
    request.body = {
      hashed_order: 'invalid',
      id: 'invoice-id',
      status: 'paid',
    }

    await controller.handleRequest(request, response)

    expect(statusStub).to.have.been.calledOnceWithExactly(400)
    expect(setHeaderStub).to.have.been.calledOnceWithExactly('content-type', 'text/plain; charset=utf8')
    expect(sendStub).to.have.been.calledOnceWithExactly('Bad Request')
    expect(updateInvoiceStatusStub).not.to.have.been.called
  })

  it('rejects callbacks with mismatched hashed_order', async () => {
    request.body = {
      hashed_order: '0'.repeat(64),
      id: 'invoice-id',
      status: 'paid',
    }

    await controller.handleRequest(request, response)

    expect(statusStub).to.have.been.calledOnceWithExactly(403)
    expect(sendStub).to.have.been.calledOnceWithExactly('Forbidden')
    expect(updateInvoiceStatusStub).not.to.have.been.called
  })

  it('accepts valid signed callbacks and processes the invoice update', async () => {
    request.body = {
      amount: 21,
      created_at: '2026-04-11T00:00:00.000Z',
      description: 'Admission fee',
      hashed_order: hmacSha256('test-api-key', 'invoice-id').toString('hex'),
      id: 'invoice-id',
      lightning: {
        expires_at: '2026-04-11T01:00:00.000Z',
        payreq: 'lnbc1test',
      },
      order_id: 'pubkey',
      status: 'unpaid',
    }

    updateInvoiceStatusStub.resolves({
      confirmedAt: null,
      status: InvoiceStatus.PENDING,
    })

    await controller.handleRequest(request, response)

    expect(updateInvoiceStatusStub).to.have.been.calledOnce
    expect(confirmInvoiceStub).not.to.have.been.called
    expect(sendInvoiceUpdateNotificationStub).not.to.have.been.called
    expect(statusStub).to.have.been.calledOnceWithExactly(200)
    expect(sendStub).to.have.been.calledOnceWithExactly()
  })

  it('confirms and notifies on paid callbacks, setting confirmedAt when absent', async () => {
    request.body = {
      hashed_order: hmacSha256('test-api-key', 'invoice-id').toString('hex'),
      id: 'invoice-id',
      status: 'paid',
    }

    updateInvoiceStatusStub.resolves({
      amountRequested: 1000n,
      confirmedAt: null,
      id: 'invoice-id',
      pubkey: 'somepubkey',
      status: InvoiceStatus.COMPLETED,
    })
    confirmInvoiceStub.resolves()
    sendInvoiceUpdateNotificationStub.resolves()

    await controller.handleRequest(request, response)

    expect(updateInvoiceStatusStub).to.have.been.calledOnce
    expect(confirmInvoiceStub).to.have.been.calledOnce
    const confirmedAtArg = confirmInvoiceStub.firstCall.args[0].confirmedAt
    expect(confirmedAtArg).to.be.instanceOf(Date)
    expect(sendInvoiceUpdateNotificationStub).to.have.been.calledOnce
    expect(statusStub).to.have.been.calledOnceWithExactly(200)
    expect(sendStub).to.have.been.calledOnceWithExactly('OK')
  })
})