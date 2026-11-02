import chai from 'chai'
import { readFileSync, readdirSync } from 'fs'
import yaml from 'js-yaml'
import { join } from 'path'

const { expect } = chai

/**
 * Docker allocates dynamic addresses from the bottom of a subnet, while several
 * services are pinned by `ipv4_address`. Without an `ip_range` the two pools
 * overlap, and which container wins is decided by creation order — so
 * `otel-collector` could take `10.10.10.2` from `nostream` and the relay then
 * fails with "Address already in use" (#929). These checks hold the pools apart.
 */

type Service = {
  networks?: Record<string, { ipv4_address?: string } | string> | string[]
}

type Network = {
  ipam?: { config?: Array<{ subnet?: string; gateway?: string; ip_range?: string }> }
}

type Compose = { services?: Record<string, Service>; networks?: Record<string, Network> }

const composeFiles = (): string[] =>
  readdirSync(process.cwd())
    .filter((file) => /^docker-compose(\.[\w-]+)?\.ya?ml$/.test(file))
    .sort()

const load = (file: string): Compose =>
  yaml.load(readFileSync(join(process.cwd(), file), 'utf-8')) as Compose

/** Every static address a compose file pins, as `file: service -> address`. */
const staticAddresses = (): Array<{ file: string; service: string; address: string }> =>
  composeFiles().flatMap((file) => {
    const services = load(file).services ?? {}

    return Object.entries(services).flatMap(([name, service]) => {
      const networks = service.networks
      if (!networks || Array.isArray(networks) || typeof networks === 'string') return []

      return Object.values(networks)
        .filter((entry): entry is { ipv4_address?: string } => typeof entry === 'object' && entry !== null)
        .filter((entry) => typeof entry.ipv4_address === 'string')
        .map((entry) => ({ file, service: name, address: entry.ipv4_address as string }))
    })
  })

const ipv4ToInt = (address: string): number =>
  address.split('.').reduce((total, octet) => total * 256 + Number(octet), 0)

const parseCidr = (cidr: string): { base: number; size: number } => {
  const [address, bits] = cidr.split('/')

  return { base: ipv4ToInt(address), size: 2 ** (32 - Number(bits)) }
}

const contains = (cidr: string, address: string): boolean => {
  const { base, size } = parseCidr(cidr)
  const value = ipv4ToInt(address)

  return value >= base && value < base + size
}

describe('docker-compose network pools', () => {
  const defaultNetwork = load('docker-compose.yml').networks?.default
  const ipam = defaultNetwork?.ipam?.config?.[0] ?? {}

  it('declares an ip_range beside the static addresses', () => {
    expect(ipam.subnet, 'docker-compose.yml must declare a subnet').to.be.a('string')
    expect(
      ipam.ip_range,
      'docker-compose.yml must confine dynamic allocation with ip_range, or it can hand a pinned address to another container'
    ).to.be.a('string')
  })

  it('keeps the dynamic range inside the subnet', () => {
    const { base, size } = parseCidr(ipam.ip_range as string)
    const subnet = parseCidr(ipam.subnet as string)

    expect(base).to.be.at.least(subnet.base)
    expect(base + size).to.be.at.most(subnet.base + subnet.size)
  })

  it('keeps the gateway outside the dynamic range', () => {
    expect(contains(ipam.subnet as string, ipam.gateway as string), 'gateway must be in the subnet').to.equal(true)
    expect(contains(ipam.ip_range as string, ipam.gateway as string), 'gateway must not be allocatable').to.equal(
      false
    )
  })

  it('keeps every static address outside the dynamic range', () => {
    const addresses = staticAddresses()

    expect(addresses.length, 'no static addresses found — the extraction is broken').to.be.greaterThan(0)

    for (const { file, service, address } of addresses) {
      expect(
        contains(ipam.subnet as string, address),
        `${file}: ${service} pins ${address}, which is outside the declared subnet`
      ).to.equal(true)
      expect(
        contains(ipam.ip_range as string, address),
        `${file}: ${service} pins ${address}, which is inside the dynamic pool ${String(ipam.ip_range)}`
      ).to.equal(false)
    }
  })
})
