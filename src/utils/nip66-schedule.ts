import { Settings } from '../@types/settings'

export const DEFAULT_PROBE_INTERVAL_SECONDS = 3600
export const MIN_PROBE_INTERVAL_SECONDS = 60
export const DEFAULT_HISTORY_RETENTION_RUNS = 168

export const getEffectiveProbeIntervalSeconds = (settings: Settings): number => {
  const configured = settings.nip66?.probeIntervalSeconds ?? DEFAULT_PROBE_INTERVAL_SECONDS

  return Math.max(configured, MIN_PROBE_INTERVAL_SECONDS)
}

export const getProbeIntervalMs = (settings: Settings): number => {
  return getEffectiveProbeIntervalSeconds(settings) * 1000
}

export const getNip66HistoryRetention = (settings: Settings) => {
  const maxAgeHours = settings.nip66?.historyRetentionHours
  return {
    maxRuns: settings.nip66?.historyRetentionRuns ?? DEFAULT_HISTORY_RETENTION_RUNS,
    maxAgeHours: typeof maxAgeHours === 'number' && maxAgeHours > 0 ? maxAgeHours : undefined,
  }
}
