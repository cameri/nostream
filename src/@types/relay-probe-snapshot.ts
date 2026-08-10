import { ProbeResult } from '../utils/relay-probe/types'

export type RelayProbeRunStatus = 'ok' | 'partial' | 'failed'

export interface RelayProbeRunSnapshot {
  runAt: string
  targets: string[]
  results: ProbeResult[]
  status: RelayProbeRunStatus
}

export interface IRelayProbeSnapshotStore {
  saveLatest(snapshot: RelayProbeRunSnapshot, expirySeconds?: number): Promise<void>
  getLatest(): Promise<RelayProbeRunSnapshot | null>
}
