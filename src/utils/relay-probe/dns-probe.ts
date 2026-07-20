import { DnsRecord, ProbeTarget } from './types'

export interface DnsResolver {
  resolve4(hostname: string): Promise<DnsRecord[]>
  resolve6(hostname: string): Promise<DnsRecord[]>
  resolveCname(hostname: string): Promise<DnsRecord[]>
}

type RecordWithTtl = {
  address: string
  ttl: number
}

export const createNodeDnsResolver = (): DnsResolver => {
  // Lazy import keeps unit tests on stubbed resolvers without touching the network.
  const dns = require('dns').promises as {
    resolve4: (hostname: string, options: { ttl: true }) => Promise<RecordWithTtl[]>
    resolve6: (hostname: string, options: { ttl: true }) => Promise<RecordWithTtl[]>
    resolveCname: (hostname: string) => Promise<string[]>
  }

  return {
    resolve4: async (hostname) => {
      const entries = await dns.resolve4(hostname, { ttl: true })
      return entries.map(({ address, ttl }) => ({ type: 'A' as const, value: address, ttl }))
    },
    resolve6: async (hostname) => {
      const entries = await dns.resolve6(hostname, { ttl: true })
      return entries.map(({ address, ttl }) => ({ type: 'AAAA' as const, value: address, ttl }))
    },
    resolveCname: async (hostname) => {
      const values = await dns.resolveCname(hostname)
      return values.map((value) => ({ type: 'CNAME' as const, value }))
    },
  }
}

const collectRecords = async (resolver: DnsResolver, target: ProbeTarget): Promise<DnsRecord[]> => {
  const records: DnsRecord[] = []

  const append = async (lookup: () => Promise<DnsRecord[]>) => {
    try {
      records.push(...(await lookup()))
    } catch (error: unknown) {
      const code = (error as NodeJS.ErrnoException)?.code
      if (code === 'ENOTFOUND' || code === 'ENODATA') {
        return
      }

      throw error
    }
  }

  await append(() => resolver.resolveCname(target.hostname))
  await append(() => resolver.resolve4(target.hostname))
  await append(() => resolver.resolve6(target.hostname))

  return records
}

export const resolveDnsRecords = async (resolver: DnsResolver, target: ProbeTarget): Promise<DnsRecord[]> => {
  const records = await collectRecords(resolver, target)

  if (records.length === 0) {
    throw new Error(`No DNS records found for ${target.hostname}`)
  }

  return records
}
