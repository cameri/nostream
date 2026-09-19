import axios from 'axios'
import chai from 'chai'
import chaiAsPromised from 'chai-as-promised'
import Sinon from 'sinon'
import sinonChai from 'sinon-chai'

import { OperatorNotificationEventType } from '../../../src/@types/operator-notifications'
import { OperatorNotificationService } from '../../../src/services/operator-notification-service'

chai.use(sinonChai)
chai.use(chaiAsPromised)

const { expect } = chai

describe('OperatorNotificationService', () => {
  let sandbox: Sinon.SinonSandbox
  let deliveryLogRepository: any
  let service: OperatorNotificationService

  beforeEach(() => {
    sandbox = Sinon.createSandbox()
    deliveryLogRepository = {
      append: sandbox.stub().resolves(),
    }
    service = new OperatorNotificationService(
      () =>
        ({
          info: { relay_url: 'wss://relay.example' },
          admin: {
            notifications: {
              enabled: true,
              targets: [
                {
                  id: 'discord-main',
                  type: 'discord',
                  enabled: true,
                  url: 'https://discord.com/api/webhooks/test',
                },
              ],
              events: {
                'admission.invoice.paid': true,
              },
              retry: { maxAttempts: 5, baseDelayMs: 1000 },
            },
          },
        }) as any,
      deliveryLogRepository,
    )
    sandbox.stub(axios, 'post').resolves({ status: 204, data: {} })
  })

  afterEach(() => {
    sandbox.restore()
  })

  it('skips dispatch when notifications are disabled', async () => {
    service = new OperatorNotificationService(
      () =>
        ({
          info: { relay_url: 'wss://relay.example' },
          admin: { notifications: { enabled: false, targets: [], events: {}, retry: { maxAttempts: 5, baseDelayMs: 1000 } } },
        }) as any,
      deliveryLogRepository,
    )

    await service.dispatch(OperatorNotificationEventType.ADMISSION_INVOICE_PAID, { invoiceId: 'x' })

    expect(axios.post).to.not.have.been.called
  })

  it('delivers to enabled targets and logs success', async () => {
    await service.dispatch(OperatorNotificationEventType.ADMISSION_INVOICE_PAID, { invoiceId: 'inv-1' }, { outboxId: 'ob-1' })

    expect(axios.post).to.have.been.calledOnce
    expect(deliveryLogRepository.append).to.have.been.calledOnce
  })

  it('throws when a target delivery fails', async () => {
    ;(axios.post as Sinon.SinonStub).rejects(new Error('network down'))

    await expect(
      service.dispatch(OperatorNotificationEventType.ADMISSION_INVOICE_PAID, { invoiceId: 'inv-1' }),
    ).to.be.rejectedWith('network down')
  })
})
