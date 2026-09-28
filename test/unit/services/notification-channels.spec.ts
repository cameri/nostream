import axios from 'axios'
import chai from 'chai'
import Sinon from 'sinon'
import sinonChai from 'sinon-chai'

import { OperatorNotificationEventType } from '../../../src/@types/operator-notifications'
import { deliverToTarget, validateTargetConfig } from '../../../src/services/notification-channels'

chai.use(sinonChai)

const { expect } = chai

const envelope = {
  event: OperatorNotificationEventType.ADMISSION_INVOICE_PAID,
  relay: 'wss://relay.example',
  timestamp: new Date().toISOString(),
  data: { invoiceId: 'inv-1' },
}

describe('notification-channels', () => {
  let sandbox: Sinon.SinonSandbox

  beforeEach(() => {
    sandbox = Sinon.createSandbox()
    sandbox.stub(axios, 'post').resolves({ status: 200, data: {} })
  })

  afterEach(() => {
    sandbox.restore()
  })

  it('delivers HTTP webhook payloads', async () => {
    await deliverToTarget(
      { id: 'http-1', type: 'http', enabled: true, url: 'https://example.com/hook' },
      envelope,
    )

    expect(axios.post).to.have.been.calledOnceWith('https://example.com/hook', envelope, Sinon.match.object)
  })

  it('delivers Slack webhook payloads', async () => {
    await deliverToTarget(
      { id: 'slack-1', type: 'slack', enabled: true, url: 'https://hooks.slack.com/services/test' },
      envelope,
    )

    expect(axios.post).to.have.been.calledOnce
  })

  it('delivers Telegram bot messages', async () => {
    await deliverToTarget(
      {
        id: 'telegram-1',
        type: 'telegram',
        enabled: true,
        botToken: '123:abc',
        chatId: '-100123',
      },
      envelope,
    )

    expect(axios.post).to.have.been.calledOnceWith(
      'https://api.telegram.org/bot123:abc/sendMessage',
      Sinon.match.object,
      Sinon.match.object,
    )
  })

  it('validates required target fields', () => {
    expect(validateTargetConfig({ id: '', type: 'http', enabled: true, url: 'https://x' })).to.match(/id/)
    expect(validateTargetConfig({ id: 'x', type: 'slack', enabled: true })).to.match(/url/)
    expect(validateTargetConfig({ id: 'x', type: 'telegram', enabled: true, botToken: 't' })).to.match(/chatId/)
  })
})
