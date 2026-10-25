import { createRequire } from 'node:module'

import chai from 'chai'
import Sinon from 'sinon'
import sinonChai from 'sinon-chai'

const require = createRequire(import.meta.url)
const adminModeration = require('../../../src/utils/admin-moderation') as typeof import('../../../src/utils/admin-moderation')
const adminModerationPersist = require('../../../src/utils/admin-moderation-persist') as typeof import('../../../src/utils/admin-moderation-persist')
const recordAdminAudit = require('../../../src/utils/record-admin-audit') as typeof import('../../../src/utils/record-admin-audit')
const settingsConfig = require('../../../src/utils/settings-config') as typeof import('../../../src/utils/settings-config')

chai.use(sinonChai)

const { expect } = chai

const limits = {
  pubkey: { blacklist: [], whitelist: [] },
  kind: { blacklist: [], whitelist: [1] },
  rateLimitBypass: { pubkeys: [], ipAddresses: ['127.0.0.1'] },
}

describe('saveModerationLimitsFromRequest', () => {
  let sandbox: Sinon.SinonSandbox

  beforeEach(() => {
    sandbox = Sinon.createSandbox()
    sandbox.stub(adminModeration, 'updateAdminModerationLimits')
    sandbox.stub(settingsConfig, 'appendSettingsAuditLog')
    sandbox.stub(recordAdminAudit, 'recordAdminAuditFromRequest').resolves()
  })

  afterEach(() => {
    sandbox.restore()
  })

  it('persists limits, audits, and enqueues notification', async () => {
    const enqueue = sandbox.stub().resolves()
    await adminModerationPersist.saveModerationLimitsFromRequest(
      () => limits,
      { ip: '127.0.0.1' } as any,
      { enqueue } as any,
      'moderation.limits.updated',
    )

    expect(adminModeration.updateAdminModerationLimits).to.have.been.calledOnce
    expect(adminModeration.updateAdminModerationLimits.firstCall.args[0]).to.be.a('function')
    expect(settingsConfig.appendSettingsAuditLog).to.have.been.calledOnce
    expect(recordAdminAudit.recordAdminAuditFromRequest).to.have.been.calledOnce
    expect(enqueue).to.have.been.calledOnce
  })

  it('still completes when notification enqueue fails', async () => {
    const enqueue = sandbox.stub().rejects(new Error('db unavailable'))
    await adminModerationPersist.saveModerationLimitsFromRequest(
      () => limits,
      { ip: '127.0.0.1' } as any,
      { enqueue } as any,
      'moderation.action',
      { action: 'ban-pubkey' },
    )

    expect(adminModeration.updateAdminModerationLimits).to.have.been.calledOnce
  })
})
