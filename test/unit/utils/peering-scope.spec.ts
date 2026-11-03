import { expect } from 'chai'

import {
  expandPeeringKinds,
  peeringScopesToLiveFilters,
  peeringScopeToFilter,
  splitPeeringScope,
} from '../../../src/utils/peering-scope'

describe('peering scope filters', () => {
  it('expands kind ranges into the explicit list NIP-01 filters require', () => {
    expect(expandPeeringKinds([1, [3, 5], 4])).to.deep.equal([1, 3, 4, 5])
  })

  it('turns an absolute scope into a filter without a limit', () => {
    expect(peeringScopeToFilter({ kinds: [1, [6, 7]], since: 100, until: 200 }, 1_000)).to.deep.equal({
      kinds: [1, 6, 7],
      since: 100,
      until: 200,
    })
  })

  it('resolves a rolling window against the reconciliation time', () => {
    expect(peeringScopeToFilter({ kinds: [1], windowSeconds: 300 }, 1_000)).to.deep.equal({
      kinds: [1],
      since: 700,
    })
  })

  it('subscribes live from the recent overlap and skips scopes that already ended', () => {
    const filters = peeringScopesToLiveFilters(
      [
        { kinds: [1], since: 100 },
        { kinds: [7], until: 1_500 },
        { kinds: [6], until: 900 },
        { kinds: [30000], windowSeconds: 3600 },
      ],
      1_000,
      60,
    )

    expect(filters).to.deep.equal([
      { kinds: [1], since: 940 },
      { kinds: [7], since: 940, until: 1_500 },
      { kinds: [30000], since: 940 },
    ])
  })

  it('splits an oversized absolute range at its midpoint', () => {
    expect(splitPeeringScope({ kinds: [1], since: 100, until: 200 }, 1_000)).to.deep.equal([
      { kinds: [1], since: 100, until: 150 },
      { kinds: [1], since: 151, until: 200 },
    ])
  })

  it('splits an unbounded scope between the beginning of time and now', () => {
    expect(splitPeeringScope({ kinds: [1] }, 1_000)).to.deep.equal([
      { kinds: [1], since: 0, until: 500 },
      { kinds: [1], since: 501, until: 1_000 },
    ])
  })

  it('does not split a range that has no room left', () => {
    expect(splitPeeringScope({ kinds: [1], since: 500, until: 500 }, 1_000)).to.equal(undefined)
  })
})
