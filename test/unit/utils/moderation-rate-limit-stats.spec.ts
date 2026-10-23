import { expect } from 'chai'

import { utcDayBucketSuffix } from '../../../src/utils/moderation-rate-limit-stats'

describe('moderation-rate-limit-stats', () => {
  it('formats UTC day bucket suffixes', () => {
    const suffix = utcDayBucketSuffix(Date.UTC(2026, 9, 23, 15, 30, 0))
    expect(suffix).to.equal('20261023')
  })
})
