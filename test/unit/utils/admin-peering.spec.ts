import { expect } from 'chai'
import { PeeringPeerSyncState } from '../../../src/@types/peering'
import { Settings } from '../../../src/@types/settings'
import { mergePeeringRows } from '../../../src/utils/admin-peering'

const state = (overrides: Partial<PeeringPeerSyncState> = {}): PeeringPeerSyncState => ({
  pubkey: 'a'.repeat(64),
  relayUrl: 'wss://peer.example.com',
  status: 'live',
  scopeCount: 1,
  updatedAt: new Date().toISOString(),
  ...overrides,
})

describe('admin peering rows', () => {
  it('merges configured peers with their stored sync state', () => {
    const rows = mergePeeringRows(
      {
        peering: {
          enabled: true,
          peers: [{ pubkey: 'a'.repeat(64), relayUrl: 'wss://peer.example.com' }],
        },
      } as Settings,
      [state()],
    )

    expect(rows).to.have.length(1)
    expect(rows[0]).to.include({
      configured: true,
      enabled: true,
      stale: false,
    })
    expect(rows[0].state?.status).to.equal('live')
  })

  it('marks an enabled peer stale when it has no state or the state is old', () => {
    const rows = mergePeeringRows(
      {
        peering: {
          enabled: true,
          peers: [
            { pubkey: 'a'.repeat(64), relayUrl: 'wss://new.example.com' },
            { pubkey: 'b'.repeat(64), relayUrl: 'wss://old.example.com' },
          ],
        },
      } as Settings,
      [state({ pubkey: 'b'.repeat(64), updatedAt: '2020-01-01T00:00:00.000Z' })],
    )

    expect(rows.find((row) => row.relayUrl === 'wss://new.example.com')?.stale).to.equal(true)
    expect(rows.find((row) => row.relayUrl === 'wss://old.example.com')?.stale).to.equal(true)
  })

  it('shows stored state for a peer that was removed from settings', () => {
    const rows = mergePeeringRows({} as Settings, [state({ pubkey: 'c'.repeat(64) })])

    expect(rows[0]).to.include({ configured: false, enabled: false })
  })
})
