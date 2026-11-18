import { expect } from 'chai'

import { Settings } from '../../../src/@types/settings'
import { validateSettings } from '../../../src/utils/settings-config'

const base = (budget: unknown): Settings =>
  ({
    info: { relay_url: 'wss://relay.example.com', name: 'Test Relay' },
    network: { maxPayloadSize: 1024 },
    payments: { enabled: true },
    peering: {
      enabled: false,
      peers: [
        {
          pubkey: 'a'.repeat(64),
          relayUrl: 'wss://peer.example.com',
          budget,
        },
      ],
    },
  }) as Settings

const budgetIssues = (budget: unknown) =>
  validateSettings(base(budget)).filter((issue) => issue.path.startsWith('peering.peers[0].budget'))

describe('peering buyer budget settings', () => {
  it('accepts a per-peer budget in sats', () => {
    expect(budgetIssues({ amount: 10000, unit: 'sats', period: 2592000 })).to.deep.equal([])
  })

  it('rejects a malformed per-peer budget', () => {
    const issues = budgetIssues({ amount: 0.5, unit: 'usd', period: 0, extra: true })

    expect(issues.some((issue) => issue.path.endsWith('.amount'))).to.equal(true)
    expect(issues.some((issue) => issue.path.endsWith('.unit'))).to.equal(true)
    expect(issues.some((issue) => issue.path.endsWith('.period'))).to.equal(true)
    expect(issues.some((issue) => issue.path.endsWith('.extra'))).to.equal(true)
  })
})
