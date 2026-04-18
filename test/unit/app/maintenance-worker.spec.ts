import chai from 'chai'
import chaiAsPromised from 'chai-as-promised'
import Sinon from 'sinon'
import sinonChai from 'sinon-chai'

chai.use(sinonChai)
chai.use(chaiAsPromised)

import { IMaintenanceService, IPaymentsService } from '../../../src/@types/services'
import { MaintenanceWorker } from '../../../src/app/maintenance-worker'
import { Nip05Verification } from '../../../src/@types/nip05'
import { Settings } from '../../../src/@types/settings'

import * as nip05Utils from '../../../src/utils/nip05'

const { expect } = chai

describe('MaintenanceWorker', () => {
  let sandbox: Sinon.SinonSandbox
  let worker: MaintenanceWorker
  let nip05VerificationRepository: any
  let verifyStub: Sinon.SinonStub
  let settings: Settings
  let mockProcess: any
  let paymentsService: Sinon.SinonStubbedInstance<IPaymentsService>
  let maintenanceService: Sinon.SinonStubbedInstance<IMaintenanceService>

  beforeEach(() => {
    sandbox = Sinon.createSandbox()

    nip05VerificationRepository = {
      findByPubkey: sandbox.stub(),
      upsert: sandbox.stub().resolves(1),
      deleteByPubkey: sandbox.stub(),
      findPendingVerifications: sandbox.stub().resolves([]),
    }

    verifyStub = sandbox.stub(nip05Utils, 'verifyNip05Identifier')

    settings = {
      info: {
        relay_url: 'relay_url',
      },
      nip05: {
        mode: 'enabled',
        verifyExpiration: 604800000,
        verifyUpdateFrequency: 86400000,
        maxConsecutiveFailures: 20,
        domainWhitelist: [],
        domainBlacklist: [],
      },
    } as any

    mockProcess = {
      on: sandbox.stub().returnsThis(),
      exit: sandbox.stub(),
    }

    paymentsService = {
      getPendingInvoices: sandbox.stub().resolves([]),
      getInvoiceFromPaymentsProcessor: sandbox.stub(),
      updateInvoiceStatus: sandbox.stub(),
      confirmInvoice: sandbox.stub(),
      sendInvoiceUpdateNotification: sandbox.stub(),
    } as any

    maintenanceService = {
      clearOldEvents: sandbox.stub().resolves(),
    } as any

    worker = new MaintenanceWorker(
      mockProcess,
      paymentsService as any,
      maintenanceService as any,
      () => settings,
      nip05VerificationRepository,
    )
  })

  afterEach(() => {
    sandbox.restore()
  })

  describe('processNip05Reverifications', () => {
    it('returns early when nip05 settings are undefined', async () => {
      (settings as any).nip05 = undefined

      await (worker as any).processNip05Reverifications(settings)

      expect(nip05VerificationRepository.findPendingVerifications).not.to.have.been.called
    })

    it('returns early when mode is disabled', async () => {
      (settings as any).nip05.mode = 'disabled'

      await (worker as any).processNip05Reverifications(settings)

      expect(nip05VerificationRepository.findPendingVerifications).not.to.have.been.called
    })

    it('does nothing when no pending verifications', async () => {
      nip05VerificationRepository.findPendingVerifications.resolves([])

      await (worker as any).processNip05Reverifications(settings)

      expect(nip05VerificationRepository.findPendingVerifications).to.have.been.calledOnceWithExactly(
        86400000,
        20,
        50,
      )
      expect(verifyStub).not.to.have.been.called
    })

    it('re-verifies and updates successful verifications', async () => {
      const verification: Nip05Verification = {
        pubkey: 'a'.repeat(64),
        nip05: 'alice@example.com',
        domain: 'example.com',
        isVerified: true,
        lastVerifiedAt: new Date(Date.now() - 100000000),
        lastCheckedAt: new Date(Date.now() - 100000000),
        failureCount: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
      }

      nip05VerificationRepository.findPendingVerifications.resolves([verification])
      verifyStub.resolves(true)

      await (worker as any).processNip05Reverifications(settings)

      expect(verifyStub).to.have.been.calledOnceWithExactly('alice@example.com', 'a'.repeat(64))
      expect(nip05VerificationRepository.upsert).to.have.been.calledOnce

      const upsertArg = nip05VerificationRepository.upsert.firstCall.args[0]
      expect(upsertArg.isVerified).to.be.true
      expect(upsertArg.failureCount).to.equal(0)
      expect(upsertArg.lastVerifiedAt).to.be.an.instanceOf(Date)
    })

    it('increments failure count on failed verification', async () => {
      const verification: Nip05Verification = {
        pubkey: 'b'.repeat(64),
        nip05: 'bob@example.com',
        domain: 'example.com',
        isVerified: true,
        lastVerifiedAt: new Date(Date.now() - 100000000),
        lastCheckedAt: new Date(Date.now() - 100000000),
        failureCount: 3,
        createdAt: new Date(),
        updatedAt: new Date(),
      }

      nip05VerificationRepository.findPendingVerifications.resolves([verification])
      verifyStub.resolves(false)

      await (worker as any).processNip05Reverifications(settings)

      expect(nip05VerificationRepository.upsert).to.have.been.calledOnce

      const upsertArg = nip05VerificationRepository.upsert.firstCall.args[0]
      expect(upsertArg.isVerified).to.be.false
      expect(upsertArg.failureCount).to.equal(4)
      expect(upsertArg.lastVerifiedAt).to.deep.equal(verification.lastVerifiedAt)
    })

    it('handles individual verification errors gracefully', async () => {
      const v1: Nip05Verification = {
        pubkey: 'a'.repeat(64),
        nip05: 'alice@example.com',
        domain: 'example.com',
        isVerified: true,
        lastVerifiedAt: new Date(),
        lastCheckedAt: new Date(Date.now() - 100000000),
        failureCount: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
      }
      const v2: Nip05Verification = {
        pubkey: 'b'.repeat(64),
        nip05: 'bob@example.com',
        domain: 'example.com',
        isVerified: true,
        lastVerifiedAt: new Date(),
        lastCheckedAt: new Date(Date.now() - 100000000),
        failureCount: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
      }

      nip05VerificationRepository.findPendingVerifications.resolves([v1, v2])
      verifyStub.onFirstCall().rejects(new Error('network error'))
      verifyStub.onSecondCall().resolves(true)

      await (worker as any).processNip05Reverifications(settings)

      expect(nip05VerificationRepository.upsert).to.have.been.calledOnce
      const upsertArg = nip05VerificationRepository.upsert.firstCall.args[0]
      expect(upsertArg.pubkey).to.equal('b'.repeat(64))
    })

    it('uses configured updateFrequency and maxFailures', async () => {
      (settings as any).nip05.verifyUpdateFrequency = 3600000
      ;(settings as any).nip05.maxConsecutiveFailures = 5

      await (worker as any).processNip05Reverifications(settings)

      expect(nip05VerificationRepository.findPendingVerifications).to.have.been.calledOnceWithExactly(
        3600000,
        5,
        50,
      )
    })

    it('uses defaults when settings values are undefined', async () => {
      (settings as any).nip05.verifyUpdateFrequency = undefined
      ;(settings as any).nip05.maxConsecutiveFailures = undefined

      await (worker as any).processNip05Reverifications(settings)

      expect(nip05VerificationRepository.findPendingVerifications).to.have.been.calledOnceWithExactly(
        86400000,
        20,
        50,
      )
    })

    it('processes in passive mode', async () => {
      (settings as any).nip05.mode = 'passive'
      const verification: Nip05Verification = {
        pubkey: 'c'.repeat(64),
        nip05: 'charlie@example.com',
        domain: 'example.com',
        isVerified: true,
        lastVerifiedAt: new Date(),
        lastCheckedAt: new Date(Date.now() - 100000000),
        failureCount: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
      }

      nip05VerificationRepository.findPendingVerifications.resolves([verification])
      verifyStub.resolves(true)

      await (worker as any).processNip05Reverifications(settings)

      expect(verifyStub).to.have.been.calledOnce
      expect(nip05VerificationRepository.upsert).to.have.been.calledOnce
    })
  })

  describe('onSchedule', () => {
    it('calls maintenance service and processes invoices', async () => {
      (settings as any).payments = { enabled: true }
      maintenanceService.clearOldEvents.resolves()
      paymentsService.getPendingInvoices.resolves([])

      await (worker as any).onSchedule()

      expect(maintenanceService.clearOldEvents).to.have.been.calledOnce
      expect(paymentsService.getPendingInvoices).to.have.been.calledOnce
    })

    it('calls maintenance service even if payments are disabled', async () => {
      (settings as any).payments = { enabled: false }
      maintenanceService.clearOldEvents.resolves()

      await (worker as any).onSchedule()

      expect(maintenanceService.clearOldEvents).to.have.been.calledOnce
      expect(paymentsService.getPendingInvoices).not.to.have.been.called
    })
  })
})
