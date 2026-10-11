import { ICacheAdapter } from '../@types/adapters'
import { RelayProbeHistoryRetention, RelayProbeRunSnapshot } from '../@types/relay-probe-snapshot'

export const RELAY_PROBE_HISTORY_KEY = 'nip66:snapshot:history'
export const MAX_PROBE_HISTORY_API_LIMIT = 500

const jsonReplacer = (_key: string, value: unknown): unknown => {
  if (value instanceof Date) {
    return value.toISOString()
  }

  return value
}

export class RelayProbeHistoryStore {
  public constructor(private readonly cache: ICacheAdapter) {}

  public async append(snapshot: RelayProbeRunSnapshot, retention: RelayProbeHistoryRetention): Promise<void> {
    const score = Date.parse(snapshot.runAt)
    if (!Number.isFinite(score)) {
      return
    }

    const payload = JSON.stringify(snapshot, jsonReplacer)
    await this.cache.addToSortedSet(RELAY_PROBE_HISTORY_KEY, { [payload]: String(score) })
    await this.trim(retention)
  }

  public async list(limit: number, retention?: RelayProbeHistoryRetention): Promise<RelayProbeRunSnapshot[]> {
    if (retention) {
      await this.trim(retention)
    }

    const clamped = Math.min(Math.max(Math.floor(limit), 1), MAX_PROBE_HISTORY_API_LIMIT)
    const raw = await this.cache.getRangeFromSortedSet(RELAY_PROBE_HISTORY_KEY, -clamped, -1)

    return raw
      .map((entry) => JSON.parse(entry) as RelayProbeRunSnapshot)
      .reverse()
  }

  private async trim(retention: RelayProbeHistoryRetention): Promise<void> {
    const maxRuns = Math.max(1, Math.floor(retention.maxRuns))
    const size = await this.cache.getSortedSetSize(RELAY_PROBE_HISTORY_KEY)

    if (size > maxRuns) {
      await this.cache.removeRangeByRankFromSortedSet(RELAY_PROBE_HISTORY_KEY, 0, size - maxRuns - 1)
    }

    const maxAgeHours = retention.maxAgeHours
    if (typeof maxAgeHours === 'number' && maxAgeHours > 0) {
      const minScore = Date.now() - maxAgeHours * 3600 * 1000
      await this.cache.removeRangeByScoreFromSortedSet(RELAY_PROBE_HISTORY_KEY, 0, minScore)
    }
  }
}
