let fanoutReady = false

export const setRelayBroadcastFanoutReady = (ready: boolean): void => {
  fanoutReady = ready
}

export const isRelayBroadcastFanoutReady = (): boolean => fanoutReady

/** Resets in-process fan-out readiness. Used by unit tests only. */
export const resetRelayBroadcastFanoutState = (): void => {
  fanoutReady = false
}
