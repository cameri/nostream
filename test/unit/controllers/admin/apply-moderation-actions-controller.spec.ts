import chai from 'chai'
import Sinon from 'sinon'
import sinonChai from 'sinon-chai'

import { PostAdminModerationActionsController } from '../../../../src/controllers/admin/post-moderation-actions-controller'
import { ValidationError } from '../../../../src/utils/admin-moderation'
import * as adminModeration from '../../../../src/utils/admin-moderation'
import * as adminModerationPersist from '../../../../src/utils/admin-moderation-persist'

chai.use(sinonChai)

const { expect } = chai

const baseLimits = {
  pubkey: { blacklist: [], whitelist: [] },
  kind: { blacklist: [], whitelist: [1] },
  rateLimitBypass: { pubkeys: [], ipAddresses: [] },
}

describe('PostAdminModerationActionsController', () => {
  let sandbox: Sinon.SinonSandbox
  let outboxRepository: { enqueue: Sinon.SinonStub }
  let response: { status: Sinon.SinonStub; setHeader: Sinon.SinonStub; send: Sinon.SinonStub }

  beforeEach(() => {
    sandbox = Sinon.createSandbox()
    outboxRepository = { enqueue: sandbox.stub().resolves() }
    response = {
      status: sandbox.stub().returnsThis(),
      setHeader: sandbox.stub().returnsThis(),
      send: sandbox.stub().returnsThis(),
    }
    sandbox.stub(adminModeration, 'readAdminModerationLimits').returns(baseLimits)
    sandbox.stub(adminModerationPersist, 'saveModerationLimitsFromRequest').resolves()
  })

  afterEach(() => {
    sandbox.restore()
  })

  it('returns 400 for invalid request bodies', async () => {
    const controller = new PostAdminModerationActionsController(outboxRepository as any)
    await controller.handleRequest({ body: { action: 'not-real' } } as any, response as any)

    expect(response.status).to.have.been.calledOnceWithExactly(400)
    expect(response.send).to.have.been.calledOnceWithExactly({ error: 'Invalid request' })
    expect(adminModerationPersist.saveModerationLimitsFromRequest).to.not.have.been.called
  })

  it('returns 400 when action fields are invalid', async () => {
    const controller = new PostAdminModerationActionsController(outboxRepository as any)
    await controller.handleRequest({ body: { action: 'ban-pubkey' } } as any, response as any)

    expect(response.status).to.have.been.calledOnceWithExactly(400)
    expect(response.send.firstCall.args[0].error).to.be.a('string')
    expect(adminModerationPersist.saveModerationLimitsFromRequest).to.not.have.been.called
  })

  it('returns 400 when persistence validation fails', async () => {
    sandbox.restore()
    sandbox = Sinon.createSandbox()
    outboxRepository = { enqueue: sandbox.stub().resolves() }
    response = {
      status: sandbox.stub().returnsThis(),
      setHeader: sandbox.stub().returnsThis(),
      send: sandbox.stub().returnsThis(),
    }
    sandbox.stub(adminModeration, 'readAdminModerationLimits').returns(baseLimits)
    sandbox
      .stub(adminModerationPersist, 'saveModerationLimitsFromRequest')
      .rejects(new ValidationError('Validation failed', [{ path: 'limits.event.pubkey.blacklist', message: 'bad' }]))

    const controller = new PostAdminModerationActionsController(outboxRepository as any)
    await controller.handleRequest(
      { body: { action: 'ban-pubkey', pubkey: 'b'.repeat(64) }, ip: '127.0.0.1' } as any,
      response as any,
    )

    expect(response.status).to.have.been.calledOnceWithExactly(400)
    expect(response.send.firstCall.args[0].error).to.equal('Validation failed')
  })

  it('applies ban-pubkey and persists limits', async () => {
    const controller = new PostAdminModerationActionsController(outboxRepository as any)
    const pubkey = 'c'.repeat(64)
    await controller.handleRequest(
      { body: { action: 'ban-pubkey', pubkey }, ip: '127.0.0.1' } as any,
      response as any,
    )

    expect(adminModerationPersist.saveModerationLimitsFromRequest).to.have.been.calledOnce
    expect(response.status).to.have.been.calledOnceWithExactly(200)
    expect(response.send.firstCall.args[0].ok).to.equal(true)
    expect(response.send.firstCall.args[0].limits.pubkey.blacklist).to.include(pubkey)
  })
})
