import { expect } from 'chai'

import { clearDnsProbeCache, runProbe } from '../../../src/utils/relay-probe/index'

const PUBKEY = '22e804d26ed16b68db5259e78449e96dab5d464c8f470bda3eb1a70467f2c793'

const makeClients = (overrides: Record<string, unknown> = {}) => ({
  dns: {
    resolve4: async () => [{ type: 'A' as const, value: '93.184.216.34', ttl: 300 }],
    resolve6: async () => [],
    resolveCname: async () => {
      throw Object.assign(new Error('ENODATA'), { code: 'ENODATA' })
    },
  },
  tls: {
    connect: async () => ({
      valid: true,
      issuer: 'Example CA',
      subject: 'relay.example.com',
      expiresAt: new Date('2027-01-01T00:00:00.000Z'),
      daysUntilExpiry: 365,
    }),
  },
  ws: { measureOpenRtt: async () => 42 },
  nip11: {
    fetch: async () => ({
      statusCode: 200,
      name: 'relay.example.com',
      pubkey: PUBKEY,
    }),
  },
  ...overrides,
})

describe('runProbe', () => {
  afterEach(() => {
    clearDnsProbeCache()
  })

  it('returns structured per-check results for a clearnet relay', async () => {
    const result = await runProbe('wss://relay.example.com', {}, makeClients())

    expect(result.target.hostname).to.equal('relay.example.com')
    expect(result.dns.status).to.equal('ok')
    expect(result.dns.data?.records).to.deep.include({ type: 'A', value: '93.184.216.34', ttl: 300 })
    expect(result.tls.status).to.equal('ok')
    expect(result.wsRtt.status).to.equal('ok')
    expect(result.nip11.status).to.equal('ok')
  })

  it('skips DNS for onion destinations', async () => {
    const result = await runProbe(
      'wss://abc123def456.onion',
      {},
      makeClients({
        dns: {
          resolve4: async () => {
            throw new Error('DNS should not be called for onion hosts')
          },
          resolve6: async () => [],
          resolveCname: async () => [],
        },
      }),
    )

    expect(result.target.networkType).to.equal('tor')
    expect(result.dns.status).to.equal('skipped')
  })

  it('uses the DNS cache on repeated probes', async () => {
    let resolveCount = 0
    const clients = makeClients({
      dns: {
        resolve4: async () => {
          resolveCount += 1
          return [{ type: 'A' as const, value: '93.184.216.34', ttl: 300 }]
        },
        resolve6: async () => [],
        resolveCname: async () => {
          throw Object.assign(new Error('ENODATA'), { code: 'ENODATA' })
        },
      },
    })

    await runProbe('wss://relay.example.com', {}, clients)
    const second = await runProbe('wss://relay.example.com', {}, clients)

    expect(resolveCount).to.equal(1)
    expect(second.dns.data?.fromCache).to.equal(true)
  })

  it('surfaces probe errors without failing the full run', async () => {
    const result = await runProbe(
      'wss://relay.example.com',
      {},
      makeClients({
        tls: {
          connect: async () => {
            throw new Error('certificate expired')
          },
        },
      }),
    )

    expect(result.tls.status).to.equal('error')
    expect(result.tls.error).to.include('certificate expired')
  })

  it('times out stalled DNS probes without blocking other checks', async () => {
    const result = await runProbe(
      'wss://relay.example.com',
      { timeouts: { dnsMs: 50, tlsMs: 50, wsRttMs: 50, nip11Ms: 50 } },
      makeClients({
        dns: {
          resolve4: () => new Promise(() => undefined),
          resolve6: async () => [],
          resolveCname: async () => {
            throw Object.assign(new Error('ENODATA'), { code: 'ENODATA' })
          },
        },
      }),
    )

    expect(result.dns.status).to.equal('error')
    expect(result.dns.error).to.include('DNS probe timed out')
    expect(result.tls.status).to.equal('ok')
  }).timeout(5000)

  it('accepts NIP-11 documents without name or pubkey fields', async () => {
    const result = await runProbe(
      'wss://relay.example.com',
      {},
      makeClients({
        nip11: {
          fetch: async () => ({ statusCode: 200 }),
        },
      }),
    )

    expect(result.nip11.status).to.equal('ok')
    expect(result.nip11.data?.name).to.equal(undefined)
  })
})
