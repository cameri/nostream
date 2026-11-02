import { expect } from 'chai'
import Sinon from 'sinon'

import { createGetAdminModerationLimitsController } from '../../../src/factories/controllers/get-admin-moderation-limits-controller-factory'
import { createGetAdminModerationStatsController } from '../../../src/factories/controllers/get-admin-moderation-stats-controller-factory'
import { createPatchAdminModerationLimitsController } from '../../../src/factories/controllers/patch-admin-moderation-limits-controller-factory'
import * as dbClient from '../../../src/database/client'

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { createPostAdminModerationActionsController } = require('../../../src/factories/controllers/post-admin-moderation-actions-controller-factory')

describe('admin moderation controller factories', () => {
  let sandbox: Sinon.SinonSandbox

  beforeEach(() => {
    sandbox = Sinon.createSandbox()
    sandbox.stub(dbClient, 'getMasterDbClient').returns({} as any)
  })

  afterEach(() => {
    sandbox.restore()
  })

  it('creates moderation admin controllers', () => {
    expect(createGetAdminModerationLimitsController()).to.have.property('handleRequest')
    expect(createGetAdminModerationStatsController()).to.have.property('handleRequest')
    expect(createPatchAdminModerationLimitsController()).to.have.property('handleRequest')
    expect(createPostAdminModerationActionsController()).to.have.property('handleRequest')
  })
})
