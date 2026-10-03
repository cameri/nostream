import { expect } from 'chai'

import { appendNip11DiscoveryTags } from '../../../src/utils/nip66-nip11-tags'

describe('nip66-nip11-tags', () => {
  it('omits pow requirement tags when min_pow_difficulty is absent from NIP-11', () => {
    const result = {
      nip11: {
        status: 'ok',
        durationMs: 1,
        data: {
          statusCode: 200,
          limitation: {},
        },
      },
    } as Parameters<typeof appendNip11DiscoveryTags>[1]

    const tags: Parameters<typeof appendNip11DiscoveryTags>[0] = []
    appendNip11DiscoveryTags(tags, result)

    expect(tags.some((tag) => tag[0] === 'R' && tag[1]?.includes('pow'))).to.equal(false)
  })
})
