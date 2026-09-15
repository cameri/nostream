const DEFAULT_WS_DRAIN_TIMEOUT_MS = 30_000
const PRIMARY_SHUTDOWN_DEADLINE_BUFFER_MS = 5_000

let draining = false

export const beginDraining = (): void => {
  draining = true
}

export const isDraining = (): boolean => draining

/** Resets in-process drain state. Used by unit tests only. */
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

export const getPrimaryShutdownDeadlineMs = (): number => {
  return getWsDrainTimeoutMs() + PRIMARY_SHUTDOWN_DEADLINE_BUFFER_MS
}
