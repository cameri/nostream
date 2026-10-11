import chai from 'chai'
import Sinon from 'sinon'
import sinonChai from 'sinon-chai'

import { Settings } from '../../../../src/@types/settings'
import { RelayProbeRunSnapshot } from '../../../../src/@types/relay-probe-snapshot'
import {
  GetAdminNetworkHealthHistoryController,
  parseNetworkHealthHistoryLimit,
} from '../../../../src/controllers/admin/get-network-health-history-controller'
import { RelayProbeHistoryStore } from '../../../../src/utils/relay-probe-history'

chai.use(sinonChai)

const { expect } = chai

describe('GetAdminNetworkHealthHistoryController', () => {
  let historyStore: Sinon.SinonStubbedInstance<RelayProbeHistoryStore>
  let controller: GetAdminNetworkHealthHistoryController
  let response: {
    status: Sinon.SinonStub
    setHeader: Sinon.SinonStub
    send: Sinon.SinonStub
  }

  const settings = {
    info: { relay_url: 'wss://relay.example.com/' },
    nip66: { enabled: true, targets: [] },
  } as Settings

  const snapshot: RelayProbeRunSnapshot = {
    runAt: '2026-01-01T00:00:00.000Z',
    targets: ['wss://relay.example.com'],
    results: [],
    status: 'ok',
  }

  beforeEach(() => {
    historyStore = {
      append: Sinon.stub(),
      list: Sinon.stub().resolves([snapshot]),
    } as any

    controller = new GetAdminNetworkHealthHistoryController(historyStore, () => settings)

    response = {
      status: Sinon.stub().returnsThis(),
      setHeader: Sinon.stub().returnsThis(),
      send: Sinon.stub().returnsThis(),
    }
  })

  it('returns bounded probe history newest first', async () => {
    await controller.handleRequest({ query: { limit: '5' } } as any, response as any)

    expect(historyStore.list).to.have.been.calledOnceWithExactly(5)
    expect(response.status).to.have.been.calledOnceWithExactly(200)
    const payload = response.send.firstCall.args[0] as { runs: RelayProbeRunSnapshot[] }
    expect(payload.runs).to.have.length(1)
    expect(payload.runs[0].runAt).to.equal(snapshot.runAt)
  })

  it('rejects invalid limit query values', async () => {
    await controller.handleRequest({ query: { limit: '0' } } as any, response as any)

    expect(response.status).to.have.been.calledOnceWithExactly(400)
    expect(historyStore.list).not.to.have.been.called
  })
})

describe('parseNetworkHealthHistoryLimit', () => {
  it('defaults when limit is omitted', () => {
    expect(parseNetworkHealthHistoryLimit(undefined)).to.equal(24)
  })

  it('rejects non-positive limits', () => {
    expect(parseNetworkHealthHistoryLimit('abc')).to.equal(null)
    expect(parseNetworkHealthHistoryLimit(0)).to.equal(null)
  })
})
