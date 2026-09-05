import { expect } from 'chai'

import { getSettingsBackend } from '../../../src/utils/settings-store'

describe('settings-store backend selection', () => {
  const originalBackend = process.env.SETTINGS_BACKEND

  afterEach(() => {
    if (originalBackend === undefined) {
      delete process.env.SETTINGS_BACKEND
    } else {
      process.env.SETTINGS_BACKEND = originalBackend
    }
  })

  it('defaults to file backend', () => {
    delete process.env.SETTINGS_BACKEND

    expect(getSettingsBackend()).to.equal('file')
  })

  it('selects db backend when SETTINGS_BACKEND=db', () => {
    process.env.SETTINGS_BACKEND = 'db'

    expect(getSettingsBackend()).to.equal('db')
  })
})
