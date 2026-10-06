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

describe('network-health-mismatches', () => {
  it('warns when NIP-66 is missing from supported_nips', () => {
    const result = baseResult()
    result.nip11.data!.supportedNips = [1, 11]

    const mismatches = collectNetworkHealthMismatches(result, {})

    expect(mismatches.some((entry) => entry.code === 'nip66-not-advertised')).to.equal(true)
  })

  it('warns when NIP-11 advertises auth but probe did not observe NIP-42', () => {
    const result = baseResult()
    result.nip11.data!.limitation = { authRequired: true }

    const mismatches = collectNetworkHealthMismatches(result, {})

    expect(mismatches.some((entry) => entry.code === 'nip42-not-observed')).to.equal(true)
  })

  it('warns when probe observed NIP-42 but NIP-11 does not advertise auth', () => {
    const result = baseResult()
    result.wsRtt.data!.nip42AuthRequired = true

    const mismatches = collectNetworkHealthMismatches(result, {})

    expect(mismatches.some((entry) => entry.code === 'nip42-not-advertised')).to.equal(true)
  })

  it('warns on public URL mismatch for single-target self monitoring', () => {
    const result = baseResult()
    result.target.relayUrl = 'wss://127.0.0.1:8008/'
    result.target.wsUrl = 'wss://127.0.0.1:8008/'

    const mismatches = collectNetworkHealthMismatches(result, {
      configuredRelayUrl: 'wss://relay.example.com/',
      publicTargetKeys: new Set(['wss://relay.example.com/']),
    })

    expect(mismatches.some((entry) => entry.code === 'public-url')).to.equal(true)
  })

  it('does not warn on public URL when multiple public probe targets are configured', () => {
    const result = baseResult()
    result.target.relayUrl = 'wss://peer.example.com/'
    result.target.wsUrl = 'wss://peer.example.com/'

    const mismatches = collectNetworkHealthMismatches(result, {
      configuredRelayUrl: 'wss://relay.example.com/',
      publicTargetKeys: new Set(['wss://relay.example.com/', 'wss://peer.example.com/']),
    })

    expect(mismatches.some((entry) => entry.code === 'public-url')).to.equal(false)
  })
})
