import { expect } from 'chai'
import Sinon from 'sinon'

import * as cacheClient from '../../../../src/cache/client'
import { createGetAdminPeeringController } from '../../../../src/factories/controllers/get-admin-peering-controller-factory'

describe('get-admin-peering-controller factory', () => {
  let sandbox: Sinon.SinonSandbox

  beforeEach(() => {
    sandbox = Sinon.createSandbox()
    const client = {
      isOpen: true,
      on: function () {
        return client
      },
    }
    sandbox.stub(cacheClient, 'getCacheClient').returns(client as any)
  })

  afterEach(() => {
    sandbox.restore()
  })

  it('creates one controller and reuses it across dashboard requests', () => {
    const first = createGetAdminPeeringController()
    const second = createGetAdminPeeringController()

    expect(first).to.have.property('handleRequest')
    expect(second).to.equal(first)
  })
})
