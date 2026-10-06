import { expect } from 'chai'

import { StoredProbeResult } from '../../../src/@types/relay-probe-snapshot'
import { collectNetworkHealthMismatches } from '../../../src/utils/network-health-mismatches'

const baseResult = (): StoredProbeResult => ({
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
  wsRtt: { status: 'ok', durationMs: 1, data: { rttOpenMs: 10, address: 'wss://relay.example.com/' } },
  nip11: {
    status: 'ok',
    durationMs: 1,
    data: {
      statusCode: 200,
      supportedNips: [1, 11, 66],
      limitation: {},
    },
  },
})

const publicContext = {
  configuredRelayUrl: 'wss://relay.example.com/',
  publicTargetKeys: new Set(['wss://relay.example.com/']),
}

describe('network-health-mismatches', () => {
  it('warns when NIP-66 is missing from supported_nips on public targets', () => {
    const result = baseResult()
    result.nip11.data!.supportedNips = [1, 11]

    const mismatches = collectNetworkHealthMismatches(result, publicContext)

    expect(mismatches.some((entry) => entry.code === 'nip66-not-advertised')).to.equal(true)
  })

  it('does not warn about NIP-66 on mirror-only probe targets', () => {
    const result = baseResult()
    result.target.relayUrl = 'wss://mirror.example.com/'
    result.target.wsUrl = 'wss://mirror.example.com/'
    result.nip11.data!.supportedNips = [1, 11]

    const mismatches = collectNetworkHealthMismatches(result, publicContext)

    expect(mismatches.some((entry) => entry.code === 'nip66-not-advertised')).to.equal(false)
    expect(mismatches.some((entry) => entry.code === 'public-url')).to.equal(false)
  })

  it('warns when NIP-11 advertises auth but probe did not observe NIP-42', () => {
    const result = baseResult()
    result.nip11.data!.limitation = { authRequired: true }

    const mismatches = collectNetworkHealthMismatches(result, publicContext)

    expect(mismatches.some((entry) => entry.code === 'nip42-not-observed')).to.equal(true)
  })

  it('does not warn when restricted_writes explains observed NIP-42 on write', () => {
    const result = baseResult()
    result.nip11.data!.limitation = { restrictedWrites: true }
    result.wsRtt.data!.nip42AuthRequired = true

    const mismatches = collectNetworkHealthMismatches(result, publicContext)

    expect(mismatches.some((entry) => entry.code === 'nip42-not-advertised')).to.equal(false)
  })

  it('warns when probe observed NIP-42 auth-required without NIP-11 policy', () => {
    const result = baseResult()
    result.wsRtt.data!.nip42AuthRequired = true

    const mismatches = collectNetworkHealthMismatches(result, publicContext)

    expect(mismatches.some((entry) => entry.code === 'nip42-not-advertised')).to.equal(true)
  })

  it('warns on public URL mismatch for configured public targets', () => {
    const result = baseResult()
    result.target.relayUrl = 'wss://127.0.0.1:8008/'
    result.target.wsUrl = 'wss://127.0.0.1:8008/'

    const mismatches = collectNetworkHealthMismatches(result, {
      configuredRelayUrl: 'wss://relay.example.com/',
      publicTargetKeys: new Set(['wss://127.0.0.1:8008/']),
    })

    expect(mismatches.some((entry) => entry.code === 'public-url')).to.equal(true)
  })

  it('does not warn on public URL for static mirror peers', () => {
    const result = baseResult()
    result.target.relayUrl = 'wss://mirror.example.com/'
    result.target.wsUrl = 'wss://mirror.example.com/'

    const mismatches = collectNetworkHealthMismatches(result, publicContext)

    expect(mismatches.some((entry) => entry.code === 'public-url')).to.equal(false)
  })
})
