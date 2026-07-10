import { expect } from 'chai'

import {
  clearDnsProbeCache,
  createDefaultProbeClients,
  detectNetworkType,
  isNip11FetchTargetSafe,
  parseProbeTarget,
  runProbe,
  shouldSkipDnsProbe,
} from '../../../src/utils/relay-probe'
import { ProbeClients } from '../../../src/utils/relay-probe/run-probe'
import { TlsResult } from '../../../src/utils/relay-probe/types'

const PUBKEY = '22e804d26ed16b68db5259e78449e96dab5d464c8f470bda3eb1a70467f2c793'

describe('relay-probe target parsing', () => {
  it('parses wss relay URLs into HTTP and WebSocket probe targets', () => {
    const target = parseProbeTarget('wss://relay.example.com/nostream')

    expect(target.hostname).to.equal('relay.example.com')
    expect(target.networkType).to.equal('clearnet')
    expect(target.httpOrigin).to.equal('https://relay.example.com')
    expect(target.nip11Url).to.equal('https://relay.example.com/nostream/')
    expect(target.wsUrl).to.equal('wss://relay.example.com/nostream')
  })

  it('detects tor and i2p destinations', () => {
    expect(detectNetworkType('abc123.onion')).to.equal('tor')
    expect(detectNetworkType('relay.i2p')).to.equal('i2p')
    expect(shouldSkipDnsProbe('tor')).to.equal(true)
  })

  it('rejects non-websocket relay URLs', () => {
    expect(() => parseProbeTarget('https://relay.example.com')).to.throw('ws:// or wss://')
  })
})

describe('relay-probe safety helpers', () => {
  it('rejects unsafe NIP-11 fetch targets', () => {
    expect(isNip11FetchTargetSafe('https://relay.example.com/')).to.equal(true)
    expect(isNip11FetchTargetSafe('http://127.0.0.1/')).to.equal(false)
    expect(isNip11FetchTargetSafe('ftp://relay.example.com/')).to.equal(false)
  })
})

describe('runProbe', () => {
  afterEach(() => {
    clearDnsProbeCache()
  })

  const makeClients = (overrides: Partial<ProbeClients> = {}): ProbeClients => ({
    dns: {
      resolve4: async () => ['93.184.216.34'],
      resolve6: async () => [],
      resolveCname: async () => {
        throw Object.assign(new Error('ENODATA'), { code: 'ENODATA' })
      },
    },
    tls: {
      connect: async () =>
        ({
          valid: true,
          issuer: 'Example CA',
          subject: 'relay.example.com',
          expiresAt: new Date('2027-01-01T00:00:00.000Z'),
          daysUntilExpiry: 365,
        }) satisfies TlsResult,
    },
    ws: {
      measureOpenRtt: async () => 42,
    },
    nip11: {
      fetch: async () => ({
        statusCode: 200,
        name: 'relay.example.com',
        pubkey: PUBKEY,
      }),
    },
    ...overrides,
  })

  it('returns structured per-check results for a clearnet relay', async () => {
    const result = await runProbe('wss://relay.example.com', {}, makeClients())

    expect(result.target.hostname).to.equal('relay.example.com')
    expect(result.dns.status).to.equal('ok')
    expect(result.dns.data?.records).to.deep.include({ type: 'A', value: '93.184.216.34' })
    expect(result.tls.status).to.equal('ok')
    expect(result.tls.data?.valid).to.equal(true)
    expect(result.wsRtt.status).to.equal('ok')
    expect(result.wsRtt.data?.rttOpenMs).to.equal(42)
    expect(result.nip11.status).to.equal('ok')
    expect(result.nip11.data?.pubkey).to.equal(PUBKEY)
  })

  it('skips DNS for onion destinations', async () => {
    const dns = {
      resolve4: async () => {
        throw new Error('DNS should not be called for onion hosts')
      },
      resolve6: async () => [],
      resolveCname: async () => [],
    }

    const result = await runProbe('wss://abc123def456.onion', {}, makeClients({ dns }))

    expect(result.target.networkType).to.equal('tor')
    expect(result.dns.status).to.equal('skipped')
    expect(result.tls.status).to.equal('ok')
  })

  it('uses the DNS cache on repeated probes', async () => {
    let resolveCount = 0
    const dns = {
      resolve4: async () => {
        resolveCount += 1
        return ['93.184.216.34']
      },
      resolve6: async () => [],
      resolveCname: async () => {
        throw Object.assign(new Error('ENODATA'), { code: 'ENODATA' })
      },
    }

    const clients = makeClients({ dns })

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

    expect(result.dns.status).to.equal('ok')
    expect(result.tls.status).to.equal('error')
    expect(result.tls.error).to.include('certificate expired')
    expect(result.wsRtt.status).to.equal('ok')
    expect(result.nip11.status).to.equal('ok')
  })

  it('exposes default node-backed clients', () => {
    const clients = createDefaultProbeClients()

    expect(clients.dns).to.have.property('resolve4')
    expect(clients.tls).to.have.property('connect')
    expect(clients.ws).to.have.property('measureOpenRtt')
    expect(clients.nip11).to.have.property('fetch')
  })
})
