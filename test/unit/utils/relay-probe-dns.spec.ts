import { expect } from 'chai'

import { parseProbeTarget, resolveDnsRecords } from '../../../src/utils/relay-probe/index'

describe('relay-probe dns-probe', () => {
  it('collects A, AAAA, and CNAME records with TTL when available', async () => {
    const target = parseProbeTarget('wss://relay.example.com')
    const records = await resolveDnsRecords(
      {
        resolveCname: async () => [{ type: 'CNAME', value: 'cdn.example.com' }],
        resolve4: async () => [{ type: 'A', value: '93.184.216.34', ttl: 300 }],
        resolve6: async () => [{ type: 'AAAA', value: '2606:2800:220:1:248:1893:25c8:1946', ttl: 120 }],
      },
      target,
    )

    expect(records).to.deep.equal([
      { type: 'CNAME', value: 'cdn.example.com' },
      { type: 'A', value: '93.184.216.34', ttl: 300 },
      { type: 'AAAA', value: '2606:2800:220:1:248:1893:25c8:1946', ttl: 120 },
    ])
  })
})
