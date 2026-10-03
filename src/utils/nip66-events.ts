import { UnidentifiedEvent } from '../@types/event'
import { Tag } from '../@types/base'
import { StoredProbeResult } from '../@types/relay-probe-snapshot'
import { Settings } from '../@types/settings'
import { EventKinds, EventTags } from '../constants/base'
import { geohashSchema } from '../schemas/base-schema'
import { appendNip11DiscoveryTags, appendWsProbeDiscoveryTags } from './nip66-nip11-tags'
import { getEffectiveProbeIntervalSeconds } from './nip66-schedule'

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

  appendWsProbeDiscoveryTags(tags, result)
  appendNip11DiscoveryTags(tags, result)
  appendDnsProbeTags(tags, result.dns)
  appendTlsProbeTags(tags, result.tls)

  const nip11Content =
    result.nip11.status === 'ok' && typeof result.nip11.data?.rawDocument === 'string'
      ? result.nip11.data.rawDocument
      : ''

  return {
    kind: EventKinds.RELAY_DISCOVERY,
    pubkey: monitorPubkey,
    created_at: createdAt,
    content: nip11Content,
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
    ['c', 'open'],
    ['c', 'read'],
    ['c', 'write'],
    ['c', 'auth'],
    ['c', 'nip11'],
    ['c', 'ssl'],
    ['c', 'dns'],
  ]

  const geohash = settings.nip66?.geohash?.trim()

  if (geohash && geohashSchema.safeParse(geohash).success) {
    tags.push(['g', geohash])
  }

  if (timeouts) {
    tags.push(['timeout', 'open', String(timeouts.wsRttMs)])
    tags.push(['timeout', 'read', String(timeouts.wsRttMs)])
    tags.push(['timeout', 'write', String(timeouts.wsRttMs)])
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

export const buildMonitorProfileEvent = (
  monitorPubkey: string,
  createdAt: number,
  settings?: Settings,
): UnidentifiedEvent => {
  const relayName = settings?.info?.name?.trim()

  return {
    kind: EventKinds.SET_METADATA,
    pubkey: monitorPubkey,
    created_at: createdAt,
    content: JSON.stringify({
      name: relayName ? `${relayName} (self-hosted monitor)` : 'Nostream self-hosted relay monitor',
      about:
        'Self-hosted NIP-66 monitor for this Nostream relay. Measurements reflect this relay’s network vantage only and are not authoritative for the wider network.',
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
