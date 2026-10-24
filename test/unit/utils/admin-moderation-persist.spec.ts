import chai from 'chai'
import Sinon from 'sinon'
import sinonChai from 'sinon-chai'

import * as adminModeration from '../../../src/utils/admin-moderation'
import { saveModerationLimitsFromRequest } from '../../../src/utils/admin-moderation-persist'
import * as recordAdminAudit from '../../../src/utils/record-admin-audit'
import * as settingsConfig from '../../../src/utils/settings-config'

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
    sandbox.stub(adminModeration, 'persistAdminModerationLimits')
    sandbox.stub(settingsConfig, 'appendSettingsAuditLog')
    sandbox.stub(recordAdminAudit, 'recordAdminAuditFromRequest').resolves()
  })

  afterEach(() => {
    sandbox.restore()
  })

  it('persists limits, audits, and enqueues notification', async () => {
    const enqueue = sandbox.stub().resolves()
    await saveModerationLimitsFromRequest(
      limits,
      { ip: '127.0.0.1' } as any,
      { enqueue } as any,
      'moderation.limits.updated',
    )

    expect(adminModeration.persistAdminModerationLimits).to.have.been.calledOnceWithExactly(limits)
    expect(settingsConfig.appendSettingsAuditLog).to.have.been.calledOnce
    expect(recordAdminAudit.recordAdminAuditFromRequest).to.have.been.calledOnce
    expect(enqueue).to.have.been.calledOnce
  })

  it('still completes when notification enqueue fails', async () => {
    const enqueue = sandbox.stub().rejects(new Error('db unavailable'))
    await saveModerationLimitsFromRequest(
      limits,
      { ip: '127.0.0.1' } as any,
      { enqueue } as any,
      'moderation.action',
      { action: 'ban-pubkey' },
    )

    expect(adminModeration.persistAdminModerationLimits).to.have.been.calledOnce
  })
})
