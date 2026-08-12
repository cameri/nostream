export type ProbeNetworkType = 'clearnet' | 'tor' | 'i2p'

export type ProbeCheckStatus = 'ok' | 'error' | 'skipped'

export interface ProbeCheckResult<T = undefined> {
  status: ProbeCheckStatus
  durationMs: number
  data?: T
  error?: string
}

export interface ProbeTarget {
  relayUrl: string
  hostname: string
  port?: number
  networkType: ProbeNetworkType
  httpOrigin: string
  nip11Url: string
  wsUrl: string
}

export type DnsRecordType = 'A' | 'AAAA' | 'CNAME'

export interface DnsRecord {
  type: DnsRecordType
  value: string
  ttl?: number
}

export interface DnsResult {
  hostname: string
  records: DnsRecord[]
  fromCache: boolean
  cacheExpiresAt?: Date
}

export interface TlsResult {
  valid: boolean
  issuer?: string
  subject?: string
  expiresAt?: Date
  daysUntilExpiry?: number
}

export interface WsRttResult {
  rttOpenMs: number
  address: string
}

export interface Nip11Result {
  statusCode: number
  name?: string
  pubkey?: string
}

export interface ProbeResult {
  target: ProbeTarget
  checkedAt: Date
  dns: ProbeCheckResult<DnsResult>
  tls: ProbeCheckResult<TlsResult>
  wsRtt: ProbeCheckResult<WsRttResult>
  nip11: ProbeCheckResult<Nip11Result>
}

export interface ProbeTimeouts {
  dnsMs: number
  tlsMs: number
  wsRttMs: number
  nip11Ms: number
}

export const DEFAULT_PROBE_TIMEOUTS: ProbeTimeouts = {
  dnsMs: 10_000,
  tlsMs: 10_000,
  wsRttMs: 10_000,
  nip11Ms: 10_000,
}

export const DEFAULT_DNS_CACHE_TTL_SECONDS = 300

export interface ProbeOptions {
  timeouts?: Partial<ProbeTimeouts>
  dnsCacheTtlSeconds?: number
  skipDnsCache?: boolean
}
