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
    describe('plan retention', () => {
      const plan = (id: string, limits?: unknown) => ({
        id,
        amount: 1000000n,
        intervalSeconds: 2592000,
        graceSeconds: 259200,
        ...(limits ? { limits } : {}),
      })

      const withPlans = (plans: unknown[], payments: Record<string, unknown> = {}) => {
        settings.returns({
          payments: { enabled: true, subscriptionPlans: plans, ...payments },
          limits: { event: { retention: { maxDays: 30 } } },
        } as any)
        eventRepository.deleteExpiredAndRetained.resolves({ deleted: 0, expired: 0, retained: 0 })
      }

      it('hands the retention of each plan that has one to the purge', async () => {
        withPlans([
          plan('basic', { retentionMaxDays: 90 }),
          plan('free'),
          plan('vip', { retentionMaxDays: 365, rateLimits: [] }),
        ])

        await service.clearOldEvents()

        expect(eventRepository.deleteExpiredAndRetained).to.have.been.calledOnceWithExactly({
          maxDays: 30,
          planRetention: [
            { planId: 'basic', maxDays: 90 },
            { planId: 'vip', maxDays: 365 },
          ],
          kindWhitelist: undefined,
          pubkeyWhitelist: undefined,
        })
      })

      it('purges as before when no plan has a retention', async () => {
        withPlans([plan('basic'), plan('vip', { rateLimits: [] })])

        await service.clearOldEvents()

        expect(eventRepository.deleteExpiredAndRetained.firstCall.args[0]).to.not.have.property('planRetention')
      })

      it('ignores plan retentions while payments are off', async () => {
        withPlans([plan('basic', { retentionMaxDays: 90 })], { enabled: false })

        await service.clearOldEvents()

        expect(eventRepository.deleteExpiredAndRetained.firstCall.args[0]).to.not.have.property('planRetention')
      })

      it('ignores plan retentions when no plan is configured', async () => {
        withPlans([])

        await service.clearOldEvents()

        expect(eventRepository.deleteExpiredAndRetained.firstCall.args[0]).to.not.have.property('planRetention')
      })

      it('does not purge when the global retention is off, however long the plans keep events', async () => {
        settings.returns({
          payments: { enabled: true, subscriptionPlans: [plan('basic', { retentionMaxDays: 90 })] },
          limits: { event: { retention: { maxDays: 0 } } },
        } as any)

        await service.clearOldEvents()

        expect(eventRepository.deleteExpiredAndRetained).not.to.have.been.called
      })
    })
  })
})
