import { DEFAULT_DNS_CACHE_TTL_SECONDS, DnsRecord, DnsResult } from './types'

type DnsCacheEntry = {
  records: DnsRecord[]
  expiresAt: number
}

const dnsCache = new Map<string, DnsCacheEntry>()

export const clearDnsProbeCache = (): void => {
  dnsCache.clear()
}

export const getCachedDnsResult = (hostname: string, now = Date.now()): DnsResult | undefined => {
  const entry = dnsCache.get(hostname)

  if (!entry || entry.expiresAt <= now) {
    if (entry) {
      dnsCache.delete(hostname)
    }

    return undefined
  }

  return {
    hostname,
    records: entry.records,
    fromCache: true,
    cacheExpiresAt: new Date(entry.expiresAt),
  }
}

export const setCachedDnsResult = (
  hostname: string,
  records: DnsRecord[],
  ttlSeconds = DEFAULT_DNS_CACHE_TTL_SECONDS,
  now = Date.now(),
): void => {
  dnsCache.set(hostname, {
    records,
    expiresAt: now + ttlSeconds * 1000,
  })
}
