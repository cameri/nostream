import { expect } from 'chai'
import Sinon from 'sinon'

import { ICacheAdapter } from '../../../src/@types/adapters'
import { RelayProbeRunSnapshot } from '../../../src/@types/relay-probe-snapshot'
import {
  deriveRelayProbeRunStatus,
  RelayProbeSnapshotStore,
  RELAY_PROBE_SNAPSHOT_KEY,
} from '../../../src/utils/relay-probe-snapshot'
import { ProbeResult } from '../../../src/utils/relay-probe/types'

describe('relay-probe-snapshot', () => {
  let cache: {
    getKey: Sinon.SinonStub
    setKey: Sinon.SinonStub
  }
  let store: RelayProbeSnapshotStore

  const sampleResult = (wsStatus: 'ok' | 'error'): ProbeResult =>
    ({
      target: {
        relayUrl: 'wss://relay.example.com',
        hostname: 'relay.example.com',
        networkType: 'clearnet',
        httpOrigin: 'https://relay.example.com',
        nip11Url: 'https://relay.example.com/.well-known/nostr.json',
        wsUrl: 'wss://relay.example.com',
      },
      checkedAt: new Date('2026-01-01T00:00:00.000Z'),
      dns: { status: 'ok', durationMs: 1 },
      tls: { status: 'ok', durationMs: 1 },
      wsRtt: { status: wsStatus, durationMs: 1 },
      nip11: { status: 'ok', durationMs: 1 },
    }) as ProbeResult

  beforeEach(() => {
    cache = {
      getKey: Sinon.stub(),
      setKey: Sinon.stub().resolves(true),
    }

    store = new RelayProbeSnapshotStore(cache as unknown as ICacheAdapter)
  })

  it('saves and reads the latest snapshot from Redis', async () => {
    const snapshot: RelayProbeRunSnapshot = {
      runAt: '2026-01-01T00:00:00.000Z',
      targets: ['wss://relay.example.com'],
      results: [sampleResult('ok')],
      status: 'ok',
    }

    cache.getKey.callsFake(async () => {
      const saved = cache.setKey.firstCall.args[1] as string
      return saved
    })

    await store.saveLatest(snapshot, 7200)
    const loaded = await store.getLatest()

    expect(cache.setKey).to.have.been.calledOnceWith(RELAY_PROBE_SNAPSHOT_KEY, Sinon.match.string, 7200)
    expect(loaded).to.deep.equal(JSON.parse(JSON.stringify(snapshot, (_key, value) => (value instanceof Date ? value.toISOString() : value))))
  })

  it('derives run status from ws RTT probe results', () => {
    expect(deriveRelayProbeRunStatus([sampleResult('ok')])).to.equal('ok')
    expect(deriveRelayProbeRunStatus([sampleResult('error')])).to.equal('failed')
    expect(deriveRelayProbeRunStatus([sampleResult('ok'), sampleResult('error')])).to.equal('partial')
    expect(deriveRelayProbeRunStatus([])).to.equal('failed')
  })
})
