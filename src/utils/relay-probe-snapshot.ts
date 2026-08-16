import { ICacheAdapter } from '../@types/adapters'
import {
  IRelayProbeSnapshotStore,
  ProbeRunStatusInput,
  RelayProbeRunSnapshot,
  StoredProbeResult,
} from '../@types/relay-probe-snapshot'
import { ProbeResult } from './relay-probe/types'

export const RELAY_PROBE_SNAPSHOT_KEY = 'nip66:snapshot:latest'

const jsonReplacer = (_key: string, value: unknown): unknown => {
  if (value instanceof Date) {
    return value.toISOString()
  }

  return value
}

export const serializeProbeResults = (results: ProbeResult[]): StoredProbeResult[] => {
  return JSON.parse(JSON.stringify(results, jsonReplacer)) as StoredProbeResult[]
}

export class RelayProbeSnapshotStore implements IRelayProbeSnapshotStore {
  public constructor(private readonly cache: ICacheAdapter) {}

  public async saveLatest(snapshot: RelayProbeRunSnapshot, expirySeconds?: number): Promise<void> {
    await this.cache.setKey(RELAY_PROBE_SNAPSHOT_KEY, JSON.stringify(snapshot, jsonReplacer), expirySeconds)
  }

  public async getLatest(): Promise<RelayProbeRunSnapshot | null> {
    const raw = await this.cache.getKey(RELAY_PROBE_SNAPSHOT_KEY)

    if (!raw) {
      return null
    }

    return JSON.parse(raw) as RelayProbeRunSnapshot
  }
}

export const deriveRelayProbeRunStatus = (results: ProbeRunStatusInput[]): RelayProbeRunSnapshot['status'] => {
  if (results.length === 0) {
    return 'failed'
  }

  const okCount = results.filter((result) => result.wsRtt.status === 'ok').length

  if (okCount === results.length) {
    return 'ok'
  }

  if (okCount === 0) {
    return 'failed'
  }

  return 'partial'
}
