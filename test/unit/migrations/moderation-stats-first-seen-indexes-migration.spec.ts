import { createRequire } from 'node:module'

import { expect } from 'chai'

const requireFromHere = createRequire(__filename)
const migration = requireFromHere('../../../migrations/20261025_120000_add_moderation_stats_first_seen_indexes.js')

describe('migrations/20261025_120000_add_moderation_stats_first_seen_indexes', () => {
  it('opts out of knex transaction so CREATE INDEX CONCURRENTLY can run', () => {
    expect(migration.config).to.deep.equal({ transaction: false })
  })

  it('exports up and down', () => {
    expect(migration.up).to.be.a('function')
    expect(migration.down).to.be.a('function')
  })
})
