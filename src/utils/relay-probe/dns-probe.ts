import { DnsRecord, ProbeTarget } from './types'

export interface DnsResolver {
  resolve4(hostname: string): Promise<string[]>
  resolve6(hostname: string): Promise<string[]>
  resolveCname(hostname: string): Promise<string[]>
}

export const createNodeDnsResolver = (): DnsResolver => {
  // Lazy import keeps unit tests on stubbed resolvers without touching the network.
  const dns = require('dns').promises as {
    resolve4: (hostname: string) => Promise<string[]>
    resolve6: (hostname: string) => Promise<string[]>
    resolveCname: (hostname: string) => Promise<string[]>
  }

  return {
    resolve4: (hostname) => dns.resolve4(hostname),
    resolve6: (hostname) => dns.resolve6(hostname),
    resolveCname: (hostname) => dns.resolveCname(hostname),
  }
}

const collectRecords = async (resolver: DnsResolver, target: ProbeTarget): Promise<DnsRecord[]> => {
  const records: DnsRecord[] = []

  const append = async (type: DnsRecord['type'], lookup: () => Promise<string[]>) => {
    try {
      const values = await lookup()
      for (const value of values) {
        records.push({ type, value })
      }
    } catch (error: unknown) {
      const code = (error as NodeJS.ErrnoException)?.code
      if (code === 'ENOTFOUND' || code === 'ENODATA') {
        return
      }

      throw error
    }
  }

  await append('CNAME', () => resolver.resolveCname(target.hostname))
  await append('A', () => resolver.resolve4(target.hostname))
  await append('AAAA', () => resolver.resolve6(target.hostname))

  return records
}

export const resolveDnsRecords = async (resolver: DnsResolver, target: ProbeTarget): Promise<DnsRecord[]> => {
  const records = await collectRecords(resolver, target)

  if (records.length === 0) {
    throw new Error(`No DNS records found for ${target.hostname}`)
  }

  return records
}
