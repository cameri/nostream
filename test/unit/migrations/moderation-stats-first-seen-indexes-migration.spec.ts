import { createRequire } from 'node:module'
import { join } from 'node:path'

import { expect } from 'chai'
import Sinon from 'sinon'

// createRequire works whether mocha loads this spec as CommonJS or as an ES module.
const requireFromRepo = createRequire(join(process.cwd(), 'package.json'))
const migration = requireFromRepo('./migrations/20261025_120000_add_moderation_stats_first_seen_indexes.js')

describe('migrations/20261025_120000_add_moderation_stats_first_seen_indexes', () => {
  it('opts out of knex transaction so CREATE INDEX CONCURRENTLY can run', () => {
    expect(migration.config).to.deep.equal({ transaction: false })
  })

  it('exports up and down', () => {
    expect(migration.up).to.be.a('function')
    expect(migration.down).to.be.a('function')
  })

  it('drops an invalid leftover index before recreating it', async () => {
    const statements: string[] = []
    const raw = Sinon.stub().callsFake(async (sql: string, bindings?: unknown[]) => {
      statements.push(sql)
      if (sql.includes('SELECT 1') && bindings?.[0] === 'events_live_first_seen_pubkey_idx') {
        return { rows: [{ '?column?': 1 }] }
      }
      return { rows: [] }
    })

    await migration.up({ raw })

    expect(raw.calledWith('DROP INDEX CONCURRENTLY IF EXISTS ??', ['events_live_first_seen_pubkey_idx'])).to.equal(true)
    expect(raw.calledWith('DROP INDEX CONCURRENTLY IF EXISTS ??', ['events_live_first_seen_remote_address_idx'])).to.equal(
      false,
    )
    expect(statements.filter((sql) => sql.includes('CREATE INDEX CONCURRENTLY IF NOT EXISTS')).length).to.equal(2)
  })
})
