import chai from 'chai'

import { EventKinds, EventTags } from '../../../src/constants/base'
import { StoredProbeResult } from '../../../src/@types/relay-probe-snapshot'
import { Settings } from '../../../src/@types/settings'
import {
  buildMonitorAnnouncementEvent,
  buildMonitorProfileEvent,
  buildMonitorRelayListEvent,
  buildRelayDiscoveryEvent,
  normalizeRelayUrlForDTag,
} from '../../../src/utils/nip66-events'

const { expect } = chai

const monitorPubkey = 'a'.repeat(64)

const storedProbeResult = (relayUrl = 'wss://Relay.Example.com:443/'): StoredProbeResult =>
  ({
    target: {
      relayUrl,
      hostname: 'relay.example.com',
      networkType: 'clearnet',
      httpOrigin: 'https://relay.example.com',
      nip11Url: 'https://relay.example.com/.well-known/nostr.json',
      wsUrl: 'wss://relay.example.com',
    },
    checkedAt: '2026-01-01T00:00:00.000Z',
    dns: { status: 'ok', durationMs: 1 },
    tls: { status: 'ok', durationMs: 1 },
    wsRtt: { status: 'ok', durationMs: 12, data: { rttOpenMs: 234, address: '127.0.0.1:443' } },
    nip11: { status: 'ok', durationMs: 1 },
  }) as StoredProbeResult

describe('nip66-events', () => {
  it('normalizes relay URLs for the d tag', () => {
    expect(normalizeRelayUrlForDTag('wss://Relay.Example.com:443/')).to.equal('wss://relay.example.com/')
    expect(normalizeRelayUrlForDTag('ws://localhost:18808')).to.equal('ws://localhost:18808/')
  })

  it('builds kind 30166 relay discovery events from probe results', () => {
    const event = buildRelayDiscoveryEvent(storedProbeResult(), monitorPubkey, 1_700_000_000)

    expect(event.kind).to.equal(EventKinds.RELAY_DISCOVERY)
    expect(event.pubkey).to.equal(monitorPubkey)
    expect(event.tags).to.deep.include(['d', 'wss://relay.example.com/'])
    expect(event.tags).to.deep.include(['n', 'clearnet'])
    expect(event.tags).to.deep.include(['rtt-open', '234'])
  })

  it('builds kind 10166 monitor announcement events', () => {
    const settings = {
      info: { relay_url: 'wss://relay.example.com' },
      nip66: {
        enabled: true,
        probeIntervalSeconds: 3600,
        targets: [],
        timeouts: {
          dnsMs: 1000,
          tlsMs: 2000,
          wsRttMs: 3000,
          nip11Ms: 4000,
        },
        dnsCacheTtlSeconds: 300,
      },
    } as Settings

    const event = buildMonitorAnnouncementEvent(settings, monitorPubkey, 1_700_000_000)

    expect(event.kind).to.equal(EventKinds.RELAY_MONITOR_ANNOUNCEMENT)
    expect(event.tags).to.deep.include(['frequency', '3600'])
    expect(event.tags).to.deep.include(['timeout', 'open', '3000'])
    expect(event.tags).to.deep.include(['timeout', 'nip11', '4000'])
    expect(event.tags).to.deep.include(['c', 'dns'])
  })

  it('builds bootstrap profile and relay list events', () => {
    const profile = buildMonitorProfileEvent(monitorPubkey, 1)
    const relayList = buildMonitorRelayListEvent('wss://relay.example.com', monitorPubkey, 1)

    expect(profile.kind).to.equal(EventKinds.SET_METADATA)
    expect(JSON.parse(profile.content).name).to.equal('Nostream Relay Monitor')

    expect(relayList.kind).to.equal(EventKinds.RELAY_LIST)
    expect(relayList.tags).to.deep.equal([
      [EventTags.Relay, 'wss://relay.example.com', 'read'],
      [EventTags.Relay, 'wss://relay.example.com', 'write'],
    ])
  })
})
