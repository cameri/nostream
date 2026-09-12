const DEFAULT_WS_DRAIN_TIMEOUT_MS = 30_000

let draining = false

export const beginDraining = (): void => {
  draining = true
}

export const isDraining = (): boolean => draining

export const resetDrainingState = (): void => {
  draining = false
}

export const getWsDrainTimeoutMs = (): number => {
  const raw = process.env.WS_DRAIN_TIMEOUT_MS
  if (raw === undefined || raw === '') {
    return DEFAULT_WS_DRAIN_TIMEOUT_MS
  }

  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed < 0) {
    return DEFAULT_WS_DRAIN_TIMEOUT_MS
  }

  return parsed
}
