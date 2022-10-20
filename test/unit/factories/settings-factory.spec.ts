import { expect } from 'chai'
import Sinon from 'sinon'

import { createSettings } from '../../../src/factories/settings-factory'
import { SettingsStatic } from '../../../src/utils/settings'

describe('getSettings', () => {
 let createSettingsStub: Sinon.SinonStub

  beforeEach(() => {
    createSettingsStub = Sinon.stub(SettingsStatic, 'createSettings')
  })

  afterEach(() => {
    createSettingsStub.restore()
  })

  it('calls createSettings and returns', () => {
    const settings = Symbol()
    createSettingsStub.returns(settings)

    expect(createSettings()).to.equal(settings)
  })
})