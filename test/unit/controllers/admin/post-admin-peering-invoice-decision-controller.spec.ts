import chai from 'chai'
import Sinon from 'sinon'
import sinonChai from 'sinon-chai'

import { PostAdminPeeringInvoiceDecisionController } from '../../../../src/controllers/admin/post-admin-peering-invoice-decision-controller'

chai.use(sinonChai)
const { expect } = chai

const response = () => {
  const res: any = {
    status: Sinon.stub().returnsThis(),
    setHeader: Sinon.stub().returnsThis(),
    send: Sinon.stub(),
  }
  return res
}

const invoice = {
  paymentHash: 'hash',
  eventId: 'event-1',
  peerPubkey: 'a'.repeat(64),
  amountMsats: 1000n,
  status: 'paid',
  reason: null,
  autoPaid: false,
  seenCount: 1,
  createdAt: new Date(),
  updatedAt: new Date(),
}

describe('PostAdminPeeringInvoiceDecisionController', () => {
  it('approves a held invoice', async () => {
    const buyer = { approve: Sinon.stub().resolves(invoice), reject: Sinon.stub() }
    const controller = new PostAdminPeeringInvoiceDecisionController(buyer as any)
    const res = response()

    await controller.handleRequest({ body: { paymentHash: 'hash', action: 'approve' } } as any, res)

    expect(buyer.approve).to.have.been.calledWith('hash')
    expect(res.status).to.have.been.calledWith(200)
    expect(res.send.firstCall.args[0].invoice.amountMsats).to.equal('1000')
  })

  it('rejects a held invoice', async () => {
    const buyer = { approve: Sinon.stub(), reject: Sinon.stub().resolves({ ...invoice, status: 'rejected' }) }
    const controller = new PostAdminPeeringInvoiceDecisionController(buyer as any)
    const res = response()

    await controller.handleRequest({ body: { paymentHash: 'hash', action: 'reject' } } as any, res)

    expect(buyer.reject).to.have.been.calledWith('hash')
    expect(res.status).to.have.been.calledWith(200)
  })

  it('rejects an invalid request', async () => {
    const controller = new PostAdminPeeringInvoiceDecisionController({} as any)
    const res = response()

    await controller.handleRequest({ body: { action: 'pay' } } as any, res)

    expect(res.status).to.have.been.calledWith(400)
  })

  it('returns 400 when the invoice cannot be decided', async () => {
    const buyer = { approve: Sinon.stub().rejects(new Error('not awaiting approval')), reject: Sinon.stub() }
    const controller = new PostAdminPeeringInvoiceDecisionController(buyer as any)
    const res = response()

    await controller.handleRequest({ body: { paymentHash: 'hash', action: 'approve' } } as any, res)

    expect(res.status).to.have.been.calledWith(400)
    expect(res.send.firstCall.args[0].error).to.equal('not awaiting approval')
  })
})
