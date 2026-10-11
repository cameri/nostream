import { expect } from 'chai'
import Sinon from 'sinon'

import { RelayProbeRunSnapshot } from '../../../src/@types/relay-probe-snapshot'
import {
  RELAY_PROBE_HISTORY_KEY,
  RelayProbeHistoryStore,
} from '../../../src/utils/relay-probe-history'
import { serializeProbeResults } from '../../../src/utils/relay-probe-snapshot'
import { ProbeResult } from '../../../src/utils/relay-probe/types'

describe('relay-probe-history', () => {
  let cache: {
    addToSortedSet: Sinon.SinonStub
    getRangeFromSortedSet: Sinon.SinonStub
    removeRangeByScoreFromSortedSet: Sinon.SinonStub
  }
  let store: RelayProbeHistoryStore

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
      addToSortedSet: Sinon.stub().resolves(1),
      getRangeFromSortedSet: Sinon.stub().resolves([]),
      removeRangeByScoreFromSortedSet: Sinon.stub().resolves(0),
    }

    store = new RelayProbeHistoryStore(cache as any)
  })

  it('appends probe runs to bounded history', async () => {
    const snapshot: RelayProbeRunSnapshot = {
      runAt: '2026-01-01T00:00:00.000Z',
      targets: ['wss://relay.example.com'],
      results: serializeProbeResults([sampleResult('ok')]),
      status: 'ok',
    }

    const older: RelayProbeRunSnapshot = {
      runAt: '2025-12-31T00:00:00.000Z',
      targets: [],
      results: [],
      status: 'failed',
    }

    cache.getRangeFromSortedSet.onFirstCall().resolves([JSON.stringify(older), JSON.stringify(snapshot)])

    await store.append(snapshot, { maxRuns: 1 })

    expect(cache.addToSortedSet).to.have.been.calledOnce
    expect(cache.removeRangeByScoreFromSortedSet).to.have.been.called
  })

  it('returns the newest history entries up to the requested limit', async () => {
    const older: RelayProbeRunSnapshot = {
      runAt: '2026-01-01T00:00:00.000Z',
      targets: [],
      results: [],
      status: 'partial',
    }
    const newer: RelayProbeRunSnapshot = {
      runAt: '2026-01-02T00:00:00.000Z',
      targets: [],
      results: [],
      status: 'ok',
    }

    cache.getRangeFromSortedSet.resolves([JSON.stringify(older), JSON.stringify(newer)])

    const history = await store.list(2)

    expect(cache.getRangeFromSortedSet).to.have.been.calledOnceWith(RELAY_PROBE_HISTORY_KEY, -2, -1)
    expect(history.map((entry) => entry.runAt)).to.deep.equal([newer.runAt, older.runAt])
  })
})
