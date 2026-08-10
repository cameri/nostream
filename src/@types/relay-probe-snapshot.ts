import {
  DnsRecord,
  Nip11Result,
  ProbeCheckResult,
  ProbeResult,
  ProbeTarget,
  WsRttResult,
} from '../utils/relay-probe/types'

export type RelayProbeRunStatus = 'ok' | 'partial' | 'failed'

export interface StoredDnsResult {
  hostname: string
  records: DnsRecord[]
  fromCache: boolean
  cacheExpiresAt?: string
}

export interface StoredTlsResult {
  valid: boolean
  issuer?: string
  subject?: string
  expiresAt?: string
  daysUntilExpiry?: number
}

export interface StoredProbeResult {
  target: ProbeTarget
  checkedAt: string
  dns: ProbeCheckResult<StoredDnsResult>
  tls: ProbeCheckResult<StoredTlsResult>
  wsRtt: ProbeCheckResult<WsRttResult>
  nip11: ProbeCheckResult<Nip11Result>
}

export interface RelayProbeRunSnapshot {
  runAt: string
  targets: string[]
  results: StoredProbeResult[]
  status: RelayProbeRunStatus
}

export interface IRelayProbeSnapshotStore {
  saveLatest(snapshot: RelayProbeRunSnapshot, expirySeconds?: number): Promise<void>
  getLatest(): Promise<RelayProbeRunSnapshot | null>
}

export type ProbeRunStatusInput = Pick<StoredProbeResult, 'wsRtt'>
