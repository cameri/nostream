import { ProbeNetworkType, ProbeTarget } from './types'

const ONION_SUFFIX = '.onion'
const I2P_SUFFIX = '.i2p'

export const detectNetworkType = (hostname: string): ProbeNetworkType => {
  const lowerHostname = hostname.toLowerCase()

  if (lowerHostname.endsWith(ONION_SUFFIX)) {
    return 'tor'
  }

  if (lowerHostname.endsWith(I2P_SUFFIX)) {
    return 'i2p'
  }

  return 'clearnet'
}

export const shouldSkipDnsProbe = (networkType: ProbeNetworkType): boolean => {
  // Tor hidden services and I2P destinations do not use public DNS.
  return networkType === 'tor' || networkType === 'i2p'
}

export const parseProbeTarget = (relayUrl: string): ProbeTarget => {
  const trimmed = relayUrl.trim()

  if (!trimmed) {
    throw new Error('Relay URL is required')
  }

  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    throw new Error(`Invalid relay URL: ${relayUrl}`)
  }

  if (parsed.protocol !== 'wss:' && parsed.protocol !== 'ws:') {
    throw new Error(`Relay URL must use ws:// or wss:// scheme: ${relayUrl}`)
  }

  if (!parsed.hostname) {
    throw new Error(`Relay URL is missing hostname: ${relayUrl}`)
  }

  const hostname = parsed.hostname.toLowerCase()
  const networkType = detectNetworkType(hostname)
  const httpProtocol = parsed.protocol === 'wss:' ? 'https:' : 'http:'
  const httpOrigin = `${httpProtocol}//${parsed.host}`
  const nip11Path = parsed.pathname.endsWith('/') ? parsed.pathname : `${parsed.pathname || ''}/`
  const nip11Url = new URL(nip11Path, httpOrigin).toString()
  const port = parsed.port ? Number(parsed.port) : undefined

  return {
    relayUrl: trimmed,
    hostname,
    port,
    networkType,
    httpOrigin,
    nip11Url,
    wsUrl: trimmed,
  }
}
