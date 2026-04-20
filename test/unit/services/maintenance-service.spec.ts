import * as chai from 'chai'
import * as sinon from 'sinon'
import sinonChai from 'sinon-chai'

chai.use(sinonChai)

const { expect } = chai

import { IEventRepository } from '../../../src/@types/repositories'
import { MaintenanceService } from '../../../src/services/maintenance-service'
import { Settings } from '../../../src/@types/settings'

describe('MaintenanceService', () => {
  let service: MaintenanceService
  let sandbox: sinon.SinonSandbox
  let eventRepository: sinon.SinonStubbedInstance<IEventRepository>
  let settings: sinon.SinonStub

  beforeEach(() => {
    sandbox = sinon.createSandbox()
    eventRepository = {
      deleteExpiredAndRetained: sandbox.stub(),
    } as any
    settings = sandbox.stub()

    service = new MaintenanceService(eventRepository as any, settings as any)
  })

  afterEach(() => {
    sandbox.restore()
  })

  describe('clearOldEvents', () => {
    it('purges events when retention.maxDays is a positive number', async () => {
      const currentSettings: Settings = {
        limits: {
          event: {
            retention: {
              maxDays: 30,
              kind: {
                whitelist: [62],
              },
              pubkey: {
                whitelist: ['aabbcc'],
              },
            },
          },
        } as any,
      } as any
      settings.returns(currentSettings)
      eventRepository.deleteExpiredAndRetained.resolves({
        deleted: 4,
        expired: 3,
        retained: 3,
      })

      await service.clearOldEvents()

      expect(eventRepository.deleteExpiredAndRetained).to.have.been.calledOnceWithExactly({
        maxDays: 30,
        kindWhitelist: [62],
        pubkeyWhitelist: ['aabbcc'],
      })
    })

    it('does not purge events when retention.maxDays is -1', async () => {
      const currentSettings: Settings = {
        limits: {
          event: {
            retention: {
              maxDays: -1,
            },
          },
        } as any,
      } as any
      settings.returns(currentSettings)

      await service.clearOldEvents()

      expect(eventRepository.deleteExpiredAndRetained).not.to.have.been.called
    })

    it('does not purge events when retention is not configured', async () => {
      const currentSettings: Settings = {
        limits: {
          event: {},
        } as any,
      } as any
      settings.returns(currentSettings)

      await service.clearOldEvents()

      expect(eventRepository.deleteExpiredAndRetained).not.to.have.been.called
    })

    it('handles error during purge', async () => {
      const currentSettings: Settings = {
        limits: {
          event: {
            retention: {
              maxDays: 30,
            },
          },
        } as any,
      } as any
      settings.returns(currentSettings)
      eventRepository.deleteExpiredAndRetained.rejects(new Error('DB Error'))

      // Should not throw
      await service.clearOldEvents()

      expect(eventRepository.deleteExpiredAndRetained).to.have.been.calledOnce
    })
  })
})
