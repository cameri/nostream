import { expect } from 'chai'

import { Settings } from '../../../src/@types/settings'
import { filterValidProbeTargets, resolveProbeTargets } from '../../../src/utils/relay-probe-targets'

describe('relay-probe-targets', () => {
  const baseSettings = {
    info: {
      relay_url: 'wss://relay.example.com',
    },
    nip66: {
      enabled: true,
      probeIntervalSeconds: 3600,
      targets: [],
      timeouts: {
        dnsMs: 10000,
        tlsMs: 10000,
        wsRttMs: 10000,
        nip11Ms: 10000,
      },
      dnsCacheTtlSeconds: 300,
    },
  } as Settings

  it('falls back to info.relay_url when nip66.targets is empty', () => {
    expect(resolveProbeTargets(baseSettings)).to.deep.equal(['wss://relay.example.com'])
  })

  it('uses configured nip66.targets when present', () => {
    const settings = {
      ...baseSettings,
      nip66: {
        ...baseSettings.nip66!,
        targets: ['wss://one.example', 'wss://two.example'],
      },
    } as Settings

    expect(resolveProbeTargets(settings)).to.deep.equal(['wss://one.example', 'wss://two.example'])
  })

  it('filters invalid probe targets', () => {
    const filtered = filterValidProbeTargets(['wss://valid.example', 'not-a-url'])

    expect(filtered.valid).to.deep.equal(['wss://valid.example'])
    expect(filtered.invalid).to.deep.equal(['not-a-url'])
  })
})
