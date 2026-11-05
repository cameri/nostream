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
    const settings = {
      peering: {
        enabled: true,
        peers: [{ pubkey: state.pubkey, relayUrl: state.relayUrl }],
      },
    } as Settings
    const controller = new GetAdminPeeringController(stateStore as any, () => settings)
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
  })
})
