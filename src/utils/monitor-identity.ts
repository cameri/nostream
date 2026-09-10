let monitorPrivateKeyCache: string | undefined

export const getMonitorPrivateKey = (): string | undefined => {
  if (monitorPrivateKeyCache) {
    return monitorPrivateKeyCache
  }

  const configured = process.env.MONITOR_PRIVATE_KEY?.trim()

  if (!configured) {
    return undefined
  }

  monitorPrivateKeyCache = configured

  return monitorPrivateKeyCache
}

export const resetMonitorPrivateKeyCache = (): void => {
  monitorPrivateKeyCache = undefined
}
