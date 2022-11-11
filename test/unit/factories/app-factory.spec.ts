import { expect } from 'chai'

import { App } from '../../../src/app/app'
import { appFactory } from '../../../src/factories/app-factory'

describe('appFactory', () => {
  it('returns an App', () => {
    expect(appFactory()).to.be.an.instanceOf(App)
  })
})
