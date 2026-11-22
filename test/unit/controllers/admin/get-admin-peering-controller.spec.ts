import chai from 'chai'
import Sinon from 'sinon'
import sinonChai from 'sinon-chai'

import type { PeeringPeerSyncState } from '../../../../src/@types/peering'
import type { Settings } from '../../../../src/@types/settings'
import { GetAdminPeeringController } from '../../../../src/controllers/admin/get-admin-peering-controller'

chai.use(sinonChai)

const { expect } = chai

describe('GetAdminPeeringController', () => {
  it('merges configured peers with stored sync state', async () => {
    const state: PeeringPeerSyncState = {
      pubkey: 'a'.repeat(64),
      relayUrl: 'wss://peer.example.com',
      status: 'live',
      scopeCount: 1,
      updatedAt: new Date().toISOString(),
      lastReconciledAt: new Date().toISOString(),
      lagSeconds: 3,
    }
    const stateStore = { list: Sinon.stub().resolves([state]) }
    const requestStatsStore = {
      list: Sinon.stub().resolves([
        {
          pubkey: state.pubkey,
          requests: 12,
          eventsServed: 34,
          lastRequestAt: '2026-01-01T00:00:00.000Z',
          lastRequestType: 'REQ',
        },
      ]),
    }
    const settings = {
      peering: {
        enabled: true,
        peers: [{ pubkey: state.pubkey, relayUrl: state.relayUrl }],
      },
    } as Settings
    const peeringPaymentRepository = {
      list: Sinon.stub().resolves([
        {
          peerPubkey: state.pubkey,
          direction: 'sell',
          status: 'active',
          periodEnd: new Date('2026-12-01T00:00:00.000Z'),
          termAmountMsats: 21000n,
          termPeriodSeconds: 2592000,
        },
      ]),
    }
    const peeringBuyerService = {
      list: Sinon.stub().resolves([
        {
          paymentHash: 'payment-hash',
          eventId: 'event-1',
          peerPubkey: state.pubkey,
          amountMsats: 250_000_000n,
          status: 'held',
          reason: 'amount_mismatch',
          autoPaid: false,
          seenCount: 1,
          createdAt: new Date('2026-11-18T00:00:00.000Z'),
          updatedAt: new Date('2026-11-18T00:00:00.000Z'),
        },
      ]),
      budgetSummary: Sinon.stub().resolves([
        {
          scope: 'peer',
          peerPubkey: state.pubkey,
          periodStart: new Date('2026-11-18T00:00:00.000Z'),
          periodEnd: new Date('2026-12-18T00:00:00.000Z'),
          limitMsats: 10_000_000n,
          spentMsats: 250_000_000n,
          remainingMsats: 0n,
          received: 1,
          paid: 0,
          held: 1,
        },
      ]),
    }
    const controller = new GetAdminPeeringController(
      stateStore as any,
      () => settings,
      requestStatsStore as any,
      peeringPaymentRepository as any,
      peeringBuyerService as any,
    )
    const response = {
      status: Sinon.stub().returnsThis(),
      setHeader: Sinon.stub().returnsThis(),
      send: Sinon.stub(),
    }

    await controller.handleRequest({} as any, response as any)

    expect(response.status).to.have.been.calledWith(200)
    const payload = response.send.firstCall.args[0]
    expect(payload.peers).to.have.length(1)
    expect(payload.peers[0]).to.include({
      configured: true,
      enabled: true,
      stale: false,
    })
    expect(payload.peers[0].state.lagSeconds).to.equal(3)
    expect(payload.peers[0].requests).to.deep.equal({
      pubkey: state.pubkey,
      requests: 12,
      eventsServed: 34,
      lastRequestAt: '2026-01-01T00:00:00.000Z',
      lastRequestType: 'REQ',
    })
    expect(payload.peers[0].billing).to.include({
      status: 'active',
      termAmountMsats: '21000',
      termPeriodSeconds: 2592000,
    })
    expect(payload.invoices[0]).to.deep.include({
      paymentHash: 'payment-hash',
      amountMsats: '250000000',
      status: 'held',
      reason: 'amount_mismatch',
    })
    expect(peeringBuyerService.list).to.have.been.calledWith(['held', 'failed'], 500)
    expect(payload.budgets[0]).to.deep.include({
      scope: 'peer',
      limitMsats: '10000000',
      spentMsats: '250000000',
      remainingMsats: '0',
    })
  })
})
