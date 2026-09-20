import { UnidentifiedEvent } from '../@types/event'
import { Tag } from '../@types/base'
import { StoredProbeResult } from '../@types/relay-probe-snapshot'
import { Settings } from '../@types/settings'
import { EventKinds, EventTags } from '../constants/base'

const DEFAULT_PROBE_INTERVAL_SECONDS = 3600
const MIN_PROBE_INTERVAL_SECONDS = 60

export const getEffectiveProbeIntervalSeconds = (settings: Settings): number => {
  const configured = settings.nip66?.probeIntervalSeconds ?? DEFAULT_PROBE_INTERVAL_SECONDS

  return Math.max(configured, MIN_PROBE_INTERVAL_SECONDS)
}

const appendDnsProbeTags = (tags: Tag[], dns: StoredProbeResult['dns']): void => {
  if (dns.status === 'skipped') {
    tags.push(['dns', 'skipped'])
    return
  }

  if (dns.status === 'error') {
    tags.push(['dns', '!resolved'])
    return
  }

  tags.push(['dns', 'resolved'])
}

const appendTlsProbeTags = (tags: Tag[], tls: StoredProbeResult['tls']): void => {
  if (tls.status === 'skipped') {
    tags.push(['ssl', 'skipped'])
    return
  }

  if (tls.status === 'error') {
    tags.push(['ssl', '!valid'])
    return
  }

  const valid = tls.data?.valid === true
  tags.push(['ssl', valid ? 'valid' : '!valid'])

  if (tls.data?.expiresAt) {
    const expiresAtSeconds = Math.floor(new Date(tls.data.expiresAt).getTime() / 1000)
    tags.push(['ssl-expires', String(expiresAtSeconds)])
  }

  if (tls.data?.issuer) {
    tags.push(['ssl-issuer', tls.data.issuer])
  }
}

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

  appendDnsProbeTags(tags, result.dns)
  appendTlsProbeTags(tags, result.tls)

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
    ['frequency', String(getEffectiveProbeIntervalSeconds(settings))],
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
