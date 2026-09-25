import chai from 'chai'
import Sinon from 'sinon'
import sinonChai from 'sinon-chai'

import { OperatorNotificationEventType } from '../../../../src/@types/operator-notifications'
import * as adminNotificationsSettings from '../../../../src/utils/admin-notifications-settings'
import * as settingsConfig from '../../../../src/utils/settings-config'

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { PatchAdminNotificationsController } = require('../../../../src/controllers/admin/patch-notifications-controller')

chai.use(sinonChai)

const { expect } = chai

const baseNotifications = {
  enabled: false,
  targets: [
    {
      id: 'discord-1',
      type: 'discord' as const,
      enabled: true,
      url: 'https://discord.com/api/webhooks/secret',
    },
  ],
  events: { 'settings.changed': true },
  retry: { maxAttempts: 5, baseDelayMs: 1000 },
  deliveryLogRetentionDays: 30,
}

const baseMergedSettings = {
  info: { relay_url: 'wss://relay.example' },
  admin: { enabled: true, notifications: baseNotifications },
}

describe('PatchAdminNotificationsController', () => {
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

    sandbox.stub(settingsConfig, 'loadMergedSettings').returns(baseMergedSettings as any)
    sandbox.stub(settingsConfig, 'loadUserSettings').returns({ admin: { notifications: baseNotifications } } as any)
    sandbox.stub(settingsConfig, 'saveSettings')
    sandbox.stub(settingsConfig, 'appendSettingsAuditLog')
    sandbox.stub(adminNotificationsSettings, 'getRedactedAdminNotifications').returns({
      ...baseNotifications,
      targets: [{ id: 'discord-1', type: 'discord', enabled: true, url: '***' }],
    })
  })

  afterEach(() => {
    sandbox.restore()
  })

  it('returns 400 for invalid request bodies', async () => {
    const controller = new PatchAdminNotificationsController(outboxRepository as any)
    await controller.handleRequest({ body: { retry: { maxAttempts: 'five' } }, ip: '127.0.0.1' } as any, response as any)

    expect(response.status.calledOnceWithExactly(400)).to.equal(true)
    expect(response.send.calledOnceWithExactly({ error: 'Invalid request' })).to.equal(true)
    expect(outboxRepository.enqueue).to.not.have.been.called
  })

  it('returns 400 when settings validation fails after merge', async () => {
    const controller = new PatchAdminNotificationsController(outboxRepository as any)
    await controller.handleRequest(
      {
        body: {
          targets: [
            {
              id: 'telegram-new',
              type: 'telegram',
              enabled: true,
              botToken: '***',
              chatId: '123',
            },
          ],
        },
        ip: '127.0.0.1',
      } as any,
      response as any,
    )

    expect(response.status.calledOnceWithExactly(400)).to.equal(true)
    expect(response.send.firstCall.args[0].error).to.equal('Validation failed')
    expect(response.send.firstCall.args[0].issues).to.be.an('array').that.is.not.empty
    expect(settingsConfig.saveSettings).to.not.have.been.called
    expect(outboxRepository.enqueue).to.not.have.been.called
  })

  it('persists partial updates and preserves redacted secrets for existing targets', async () => {
    const controller = new PatchAdminNotificationsController(outboxRepository as any)
    await controller.handleRequest(
      {
        body: {
          enabled: true,
          targets: [
            {
              id: 'discord-1',
              type: 'discord',
              enabled: false,
              url: '***',
            },
          ],
        },
        ip: '127.0.0.1',
      } as any,
      response as any,
    )

    expect(response.status.calledOnceWithExactly(200)).to.equal(true)
    expect(settingsConfig.saveSettings).to.have.been.calledOnce
    const saved = (settingsConfig.saveSettings as Sinon.SinonStub).firstCall.args[0]
    expect(saved.admin.notifications.enabled).to.equal(true)
    expect(saved.admin.notifications.targets[0].enabled).to.equal(false)
    expect(saved.admin.notifications.targets[0].url).to.equal('https://discord.com/api/webhooks/secret')
    expect(outboxRepository.enqueue).to.have.been.calledOnceWith(
      OperatorNotificationEventType.SETTINGS_CHANGED,
      Sinon.match.object,
    )
    expect(response.send.firstCall.args[0].ok).to.equal(true)
  })

  it('still returns 200 when outbox enqueue fails', async () => {
    outboxRepository.enqueue.rejects(new Error('db unavailable'))
    const controller = new PatchAdminNotificationsController(outboxRepository as any)

    await controller.handleRequest({ body: { enabled: true }, ip: '127.0.0.1' } as any, response as any)

    expect(response.status.calledOnceWithExactly(200)).to.equal(true)
    expect(settingsConfig.saveSettings).to.have.been.calledOnce
  })
})
