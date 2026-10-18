import { expect } from 'chai'

import { buildStorageCountFilters, parseAdminOpsStorageQuery } from '../../../src/utils/admin-ops-storage'

describe('admin-ops-storage', () => {
  it('requires kinds parameter', () => {
    const result = parseAdminOpsStorageQuery(undefined, undefined, undefined)
    expect(result.error).to.match(/kinds/)
  })

  it('parses kinds and builds per-kind filters', () => {
    const parsed = parseAdminOpsStorageQuery('1,7,7', '100', '200')
    expect(parsed.error).to.be.undefined
    expect(parsed.query?.kinds).to.deep.equal([1, 7])

    const filters = buildStorageCountFilters(parsed.query!)
    expect(filters).to.have.length(2)
    expect(filters[0]).to.deep.equal({ since: 100, until: 200, kinds: [1] })
    expect(filters[1]).to.deep.equal({ since: 100, until: 200, kinds: [7] })
  })

  it('rejects invalid kind values', () => {
    const result = parseAdminOpsStorageQuery('1,abc', undefined, undefined)
    expect(result.error).to.match(/kinds/)
  })
})
