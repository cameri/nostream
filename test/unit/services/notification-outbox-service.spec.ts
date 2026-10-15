import chai from 'chai'
import chaiAsPromised from 'chai-as-promised'
import Sinon from 'sinon'
import sinonChai from 'sinon-chai'

import { NotificationOutboxEventType, NotificationOutboxStatus } from '../../../src/@types/notification-outbox'
import { NotificationOutboxService } from '../../../src/services/notification-outbox-service'

chai.use(sinonChai)
chai.use(chaiAsPromised)

const { expect } = chai

describe('NotificationOutboxService', () => {
  let sandbox: Sinon.SinonSandbox
  let outboxRepository: any
  let dispatcher: any
  let service: NotificationOutboxService

  const message = {
    id: 'msg-1',
    eventType: NotificationOutboxEventType.OPERATOR_INVOICE_PAID,
    payload: { invoiceId: 'inv-1' },
    status: NotificationOutboxStatus.PROCESSING,
    attemptCount: 0,
    availableAt: new Date(),
    lastError: null,
    deliveredAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  }

  beforeEach(() => {
    sandbox = Sinon.createSandbox()
    outboxRepository = {
      claimBatch: sandbox.stub().resolves([]),
      markDelivered: sandbox.stub().resolves(),
      markFailed: sandbox.stub().resolves(),
    }
    dispatcher = {
      dispatch: sandbox.stub().resolves(),
    }
    service = new NotificationOutboxService(outboxRepository, dispatcher)
  })

  afterEach(() => {
    sandbox.restore()
  })

  it('returns 0 when the outbox is empty', async () => {
    await expect(service.processBatch()).to.eventually.equal(0)
  })

  it('marks a message delivered after dispatch succeeds', async () => {
    outboxRepository.claimBatch.resolves([message])

    await expect(service.processBatch()).to.eventually.equal(1)

    expect(dispatcher.dispatch).to.have.been.calledOnceWith(message.eventType, message.payload, {
      outboxId: message.id,
      attemptNumber: 1,
    })
    expect(outboxRepository.markDelivered).to.have.been.calledOnceWith(message.id)
  })

  it('schedules a retry when dispatch fails', async () => {
    outboxRepository.claimBatch.resolves([message])
    dispatcher.dispatch.rejects(new Error('network down'))

    await expect(service.processBatch()).to.eventually.equal(0)

    expect(outboxRepository.markFailed).to.have.been.calledOnceWith(
      message.id,
      'network down',
      1,
      5,
      1000,
    )
  })
})
