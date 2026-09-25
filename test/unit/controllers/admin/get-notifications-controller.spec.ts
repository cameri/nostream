import chai from 'chai'
import Sinon from 'sinon'

import { GetAdminNotificationsController } from '../../../../src/controllers/admin/get-notifications-controller'
import * as adminNotificationsSettings from '../../../../src/utils/admin-notifications-settings'

const { expect } = chai

describe('GetAdminNotificationsController', () => {
  let sandbox: Sinon.SinonSandbox
  let response: { status: Sinon.SinonStub; setHeader: Sinon.SinonStub; send: Sinon.SinonStub }

  beforeEach(() => {
    sandbox = Sinon.createSandbox()
    response = {
      status: sandbox.stub().returnsThis(),
      setHeader: sandbox.stub().returnsThis(),
      send: sandbox.stub().returnsThis(),
    }
    sandbox.stub(adminNotificationsSettings, 'getRedactedAdminNotifications').returns({
      enabled: false,
      targets: [],
      events: {},
      retry: { maxAttempts: 5, baseDelayMs: 1000 },
    })
  })

  afterEach(() => {
    sandbox.restore()
  })

  it('returns redacted notifications config', async () => {
    const controller = new GetAdminNotificationsController()
    await controller.handleRequest({} as any, response as any)

    expect(response.status.calledOnceWithExactly(200)).to.equal(true)
    expect(
      response.send.calledOnceWith({
        notifications: {
          enabled: false,
          targets: [],
          events: {},
          retry: { maxAttempts: 5, baseDelayMs: 1000 },
        },
      }),
    ).to.equal(true)
  })
})
