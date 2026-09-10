import { UnidentifiedEvent } from '../@types/event'
import { Tag } from '../@types/base'
import { StoredProbeResult } from '../@types/relay-probe-snapshot'
import { Settings } from '../@types/settings'
import { EventKinds, EventTags } from '../constants/base'

export const normalizeRelayUrlForDTag = (relayUrl: string): string => {
  const parsed = new URL(relayUrl)
  parsed.protocol = parsed.protocol.toLowerCase()
  parsed.hostname = parsed.hostname.toLowerCase()

  if (
    (parsed.protocol === 'wss:' && parsed.port === '443') ||
    (parsed.protocol === 'ws:' && parsed.port === '80')
  ) {
    parsed.port = ''
  }

  let normalized = parsed.toString()

  if ((parsed.pathname === '/' || parsed.pathname === '') && !normalized.endsWith('/')) {
    normalized = `${normalized}/`
  }

  return normalized
}

export const buildRelayDiscoveryEvent = (
  result: StoredProbeResult,
  monitorPubkey: string,
  createdAt: number,
): UnidentifiedEvent => {
  const tags: Tag[] = [
    [EventTags.Deduplication, normalizeRelayUrlForDTag(result.target.relayUrl)],
    ['n', result.target.networkType],
  ]

  if (result.wsRtt.status === 'ok' && typeof result.wsRtt.data?.rttOpenMs === 'number') {
    tags.push(['rtt-open', String(result.wsRtt.data.rttOpenMs)])
  }

  return {
    kind: EventKinds.RELAY_DISCOVERY,
    pubkey: monitorPubkey,
    created_at: createdAt,
    content: '',
    tags,
  }
}

export const buildMonitorAnnouncementEvent = (
  settings: Settings,
  monitorPubkey: string,
  createdAt: number,
): UnidentifiedEvent => {
  const nip66 = settings.nip66
  const timeouts = nip66?.timeouts

  const tags: Tag[] = [
    ['frequency', String(nip66?.probeIntervalSeconds ?? 3600)],
    ['c', 'ws'],
    ['c', 'nip11'],
    ['c', 'ssl'],
    ['c', 'dns'],
  ]

  if (timeouts) {
    tags.push(['timeout', 'open', String(timeouts.wsRttMs)])
    tags.push(['timeout', 'nip11', String(timeouts.nip11Ms)])
    tags.push(['timeout', 'dns', String(timeouts.dnsMs)])
    tags.push(['timeout', 'ssl', String(timeouts.tlsMs)])
  }

  return {
    kind: EventKinds.RELAY_MONITOR_ANNOUNCEMENT,
    pubkey: monitorPubkey,
    created_at: createdAt,
    content: '',
    tags,
  }
}

export const buildMonitorProfileEvent = (monitorPubkey: string, createdAt: number): UnidentifiedEvent => {
  return {
    kind: EventKinds.SET_METADATA,
    pubkey: monitorPubkey,
    created_at: createdAt,
    content: JSON.stringify({
      name: 'Nostream Relay Monitor',
      about: 'Automated NIP-66 relay health monitor for this Nostream instance.',
    }),
    tags: [],
  }
}

export const buildMonitorRelayListEvent = (
  relayUrl: string,
  monitorPubkey: string,
  createdAt: number,
): UnidentifiedEvent => {
  return {
    kind: EventKinds.RELAY_LIST,
    pubkey: monitorPubkey,
    created_at: createdAt,
    content: '',
    tags: [
      [EventTags.Relay, relayUrl, 'read'],
      [EventTags.Relay, relayUrl, 'write'],
    ],
  }
}
