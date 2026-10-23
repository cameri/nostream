import { expect } from 'chai'

import {
  parseModerationStatsLimit,
  parseModerationStatsWindowHours,
} from '../../../src/utils/admin-moderation-stats'

describe('admin-moderation-stats parsing', () => {
  it('parses windowHours', () => {
    expect(parseModerationStatsWindowHours('24')).to.deep.equal({ hours: 24 })
    expect(parseModerationStatsWindowHours('720').hours).to.equal(720)
  })

  it('parses limit with bounds', () => {
    expect(parseModerationStatsLimit('15')).to.equal(15)
    expect(parseModerationStatsLimit('200')).to.equal(20)
    expect(parseModerationStatsLimit('0')).to.equal(20)
    expect(parseModerationStatsLimit(undefined)).to.equal(20)
  })
})
