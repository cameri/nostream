import { createRequire } from 'node:module'

import { expect } from 'chai'

const requireFromHere = createRequire(__filename)
const migration = requireFromHere('../../../migrations/20260905_120000_create_settings_overrides_table.js')

describe('migrations/20260905_120000_create_settings_overrides_table', () => {
  it('exports up and down', () => {
    expect(migration.up).to.be.a('function')
    expect(migration.down).to.be.a('function')
  })
})
