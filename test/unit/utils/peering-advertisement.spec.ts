import { expect } from 'chai'

import { fetchPeeringAdvertisement, parsePeeringAdvertisement } from '../../../src/utils/peering-advertisement'

describe('peering advertisement', () => {
  it('reads scopes and terms from the NIP-11 peering section', () => {
    const advertisement = parsePeeringAdvertisement({
      self: 'A'.repeat(64),
      supported_nips: [1, 11, 77],
      peering: {
        enabled: true,
        scopes: [
          { kinds: [1, [6, 7]], since: 100 },
          { kinds: [30023], window_seconds: 3600 },
        ],
        terms: [{ amount: 1000, unit: 'msats', period: 2592000 }],
      },
    })

    expect(advertisement).to.deep.equal({
      enabled: true,
      self: 'a'.repeat(64),
      supportedNips: [1, 11, 77],
      scopes: [
        { kinds: [1, [6, 7]], since: 100 },
        { kinds: [30023], windowSeconds: 3600 },
      ],
      terms: [{ amount: 1000, unit: 'msats', period: 2592000 }],
    })
  })

  it('reports peering as disabled when the section is absent', () => {
    const advertisement = parsePeeringAdvertisement({ supported_nips: [1] })

    expect(advertisement.enabled).to.equal(false)
    expect(advertisement.scopes).to.deep.equal([])
  })

  it('rejects an enabled advertisement with no scopes', () => {
    expect(() => parsePeeringAdvertisement({ peering: { enabled: true, scopes: [] } })).to.throw('offers no scopes')
  })

  it('rejects a scope that combines a window with an absolute range', () => {
    expect(() =>
      parsePeeringAdvertisement({
        peering: {
          enabled: true,
          scopes: [{ kinds: [1], since: 100, window_seconds: 3600 }],
        },
      }),
    ).to.throw('window_seconds cannot be combined')
  })

  it('refuses to fetch an internal NIP-11 target', async () => {
    const error = await fetchPeeringAdvertisement('ws://127.0.0.1:8008').then(
      () => undefined,
      (err: Error) => err,
    )

    expect(error?.message).to.include('refused unsafe NIP-11 fetch target')
  })
})
