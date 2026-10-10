import chai from 'chai'
import Sinon from 'sinon'
import sinonChai from 'sinon-chai'

import { Settings } from '../../../../src/@types/settings'
import { IRelayProbeSnapshotStore, RelayProbeRunSnapshot } from '../../../../src/@types/relay-probe-snapshot'
import { GetAdminNetworkHealthController } from '../../../../src/controllers/admin/get-network-health-controller'

chai.use(sinonChai)

const { expect } = chai

describe('GetAdminNetworkHealthController', () => {
  let snapshotStore: Sinon.SinonStubbedInstance<IRelayProbeSnapshotStore>
  let controller: GetAdminNetworkHealthController
  let response: {
    status: Sinon.SinonStub
    setHeader: Sinon.SinonStub
    send: Sinon.SinonStub
  }

  const settings = {
    info: { relay_url: 'wss://relay.example.com/' },
    nip66: { enabled: true, targets: [] },
  } as Settings

  beforeEach(() => {
    snapshotStore = {
      saveLatest: Sinon.stub(),
      getLatest: Sinon.stub(),
    }

    controller = new GetAdminNetworkHealthController(snapshotStore, () => settings)

    response = {
      status: Sinon.stub().returnsThis(),
      setHeader: Sinon.stub().returnsThis(),
      send: Sinon.stub().returnsThis(),
    }
  })

  it('returns the latest probe snapshot with mismatch annotations', async () => {
    const snapshot: RelayProbeRunSnapshot = {
      runAt: '2026-01-01T00:00:00.000Z',
      targets: ['wss://relay.example.com'],
      results: [
        {
          target: {
            relayUrl: 'wss://relay.example.com/',
            hostname: 'relay.example.com',
            networkType: 'clearnet',
            httpOrigin: 'https://relay.example.com',
            nip11Url: 'https://relay.example.com/.well-known/nostr.json',
            wsUrl: 'wss://relay.example.com/',
          },
          checkedAt: '2026-01-01T00:00:00.000Z',
          dns: { status: 'ok', durationMs: 1 },
          tls: { status: 'ok', durationMs: 1 },
          wsRtt: { status: 'ok', durationMs: 1, data: { rttOpenMs: 1, address: 'wss://relay.example.com/' } },
          nip11: {
            status: 'ok',
            durationMs: 1,
            data: { statusCode: 200, supportedNips: [1, 11] },
          },
        },
      ],
      status: 'ok',
    }

    snapshotStore.getLatest.resolves(snapshot)

    await controller.handleRequest({} as any, response as any)

    expect(snapshotStore.getLatest).to.have.been.calledOnce
    expect(response.status).to.have.been.calledOnceWithExactly(200)
    expect(response.setHeader).to.have.been.calledOnceWithExactly('content-type', 'application/json')
    const payload = response.send.firstCall.args[0] as { snapshot: { results: Array<{ mismatches: unknown[] }> } }
    expect(payload.snapshot.results[0].mismatches.some((entry: { code: string }) => entry.code === 'nip66-not-advertised')).to
      .equal(true)
  })

  it('returns null snapshot when no probe run has been stored yet', async () => {
    snapshotStore.getLatest.resolves(null)

    await controller.handleRequest({} as any, response as any)

    expect(response.send).to.have.been.calledOnceWithExactly({ snapshot: null })
  })
})
