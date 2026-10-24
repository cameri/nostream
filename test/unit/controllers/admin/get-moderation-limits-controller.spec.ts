import chai from 'chai'
import Sinon from 'sinon'
import sinonChai from 'sinon-chai'

import { GetAdminModerationLimitsController } from '../../../../src/controllers/admin/get-moderation-limits-controller'
import * as adminModeration from '../../../../src/utils/admin-moderation'

chai.use(sinonChai)

const { expect } = chai

describe('GetAdminModerationLimitsController', () => {
  let sandbox: Sinon.SinonSandbox
  let response: { status: Sinon.SinonStub; setHeader: Sinon.SinonStub; send: Sinon.SinonStub }

  const limits = {
    pubkey: { blacklist: ['a'.repeat(64)], whitelist: [] },
    kind: { blacklist: [], whitelist: [1] },
    rateLimitBypass: { pubkeys: [], ipAddresses: ['127.0.0.1'] },
  }

  beforeEach(() => {
    sandbox = Sinon.createSandbox()
    sandbox.stub(adminModeration, 'readAdminModerationLimits').returns(limits)
    response = {
      status: sandbox.stub().returnsThis(),
      setHeader: sandbox.stub().returnsThis(),
      send: sandbox.stub().returnsThis(),
    }
  })

  afterEach(() => {
    sandbox.restore()
  })

  it('returns current moderation limits', async () => {
    const controller = new GetAdminModerationLimitsController()
    await controller.handleRequest({} as any, response as any)

    expect(response.status).to.have.been.calledOnceWithExactly(200)
    expect(response.setHeader).to.have.been.calledWith('content-type', 'application/json')
    expect(response.send).to.have.been.calledOnceWithExactly({ limits })
  })
})
