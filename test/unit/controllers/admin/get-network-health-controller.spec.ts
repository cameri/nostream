import { expect } from 'chai'
import Sinon from 'sinon'

import { IRelayProbeSnapshotStore, RelayProbeRunSnapshot } from '../../../../src/@types/relay-probe-snapshot'
import { GetAdminNetworkHealthController } from '../../../../src/controllers/admin/get-network-health-controller'

describe('GetAdminNetworkHealthController', () => {
  let snapshotStore: Sinon.SinonStubbedInstance<IRelayProbeSnapshotStore>
  let controller: GetAdminNetworkHealthController
  let response: {
    status: Sinon.SinonStub
    setHeader: Sinon.SinonStub
    send: Sinon.SinonStub
  }

  beforeEach(() => {
    snapshotStore = {
      saveLatest: Sinon.stub(),
      getLatest: Sinon.stub(),
    }

    controller = new GetAdminNetworkHealthController(snapshotStore)

    response = {
      status: Sinon.stub().returnsThis(),
      setHeader: Sinon.stub().returnsThis(),
      send: Sinon.stub().returnsThis(),
    }
  })

  it('returns the latest probe snapshot as JSON', async () => {
    const snapshot: RelayProbeRunSnapshot = {
      runAt: '2026-01-01T00:00:00.000Z',
      targets: ['wss://relay.example.com'],
      results: [],
      status: 'ok',
    }

    snapshotStore.getLatest.resolves(snapshot)

    await controller.handleRequest({} as any, response as any)

    expect(snapshotStore.getLatest).to.have.been.calledOnce
    expect(response.status).to.have.been.calledOnceWithExactly(200)
    expect(response.setHeader).to.have.been.calledOnceWithExactly('content-type', 'application/json')
    expect(response.send).to.have.been.calledOnceWithExactly({ snapshot })
  })

  it('returns null snapshot when no probe run has been stored yet', async () => {
    snapshotStore.getLatest.resolves(null)

    await controller.handleRequest({} as any, response as any)

    expect(response.send).to.have.been.calledOnceWithExactly({ snapshot: null })
  })
})
