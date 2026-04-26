import EventEmitter from 'events'

import chai from 'chai'
import chaiAsPromised from 'chai-as-promised'
import Sinon from 'sinon'
import sinonChai from 'sinon-chai'

import { InvoiceStatus, InvoiceUnit } from '../../../src/@types/invoice'
import { Nip05Verification } from '../../../src/@types/nip05'
import { IMaintenanceService, IPaymentsService } from '../../../src/@types/services'
import { Settings } from '../../../src/@types/settings'
import { applyReverificationOutcome, MaintenanceWorker } from '../../../src/app/maintenance-worker'
import * as misc from '../../../src/utils/misc'
import * as nip05Utils from '../../../src/utils/nip05'

chai.use(sinonChai)
chai.use(chaiAsPromised)

const { expect } = chai

describe('MaintenanceWorker', () => {
  let sandbox: Sinon.SinonSandbox
  let worker: MaintenanceWorker
  let fakeProcess: EventEmitter & { exit: Sinon.SinonStub }
  let paymentsService: Sinon.SinonStubbedInstance<IPaymentsService>
  let maintenanceService: Sinon.SinonStubbedInstance<IMaintenanceService>
  let settings: Sinon.SinonStub
  let settingsState: Settings
  let nip05VerificationRepository: any
  let verifyStub: Sinon.SinonStub

  const pendingInvoice = {
    id: 'inv-1',
    pubkey: 'pubkey1234',
    status: InvoiceStatus.PENDING,
    amountRequested: 1000n,
    unit: InvoiceUnit.SATS,
    bolt11: 'lnbc...',
    description: 'test',
    confirmedAt: null,
    expiresAt: new Date('2099-01-01'),
    updatedAt: new Date(),
    createdAt: new Date(),
  }

  beforeEach(() => {
    sandbox = Sinon.createSandbox()

    fakeProcess = Object.assign(new EventEmitter(), {
      exit: sandbox.stub(),
    }) as EventEmitter & { exit: Sinon.SinonStub }

    nip05VerificationRepository = {
      findByPubkey: sandbox.stub(),
      upsert: sandbox.stub().resolves(1),
      deleteByPubkey: sandbox.stub(),
      findPendingVerifications: sandbox.stub().resolves([]),
    }

    verifyStub = sandbox.stub(nip05Utils, 'verifyNip05Identifier')

    settingsState = {
      payments: {
        enabled: true,
      },
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

    settings = sandbox.stub().callsFake(() => settingsState)

    paymentsService = {
      getPendingInvoices: sandbox.stub().resolves([]),
      getInvoiceFromPaymentsProcessor: sandbox.stub(),
      updateInvoiceStatus: sandbox.stub().resolves(),
      confirmInvoice: sandbox.stub().resolves(),
      sendInvoiceUpdateNotification: sandbox.stub().resolves(),
    } as any

    maintenanceService = {
      clearOldEvents: sandbox.stub().resolves(),
    } as any

    // Prevent real timeouts and randomized per-invoice delays.
    sandbox.stub(misc, 'delayMs').resolves()

    worker = new MaintenanceWorker(
      fakeProcess as any,
      paymentsService,
      maintenanceService,
      settings as any,
      nip05VerificationRepository,
    )
  })

  afterEach(() => {
    sandbox.restore()
  })

  const verification = (overrides: Partial<Nip05Verification> = {}): Nip05Verification => ({
    pubkey: 'a'.repeat(64),
    nip05: 'alice@example.com',
    domain: 'example.com',
    isVerified: true,
    lastVerifiedAt: new Date(Date.now() - 100000000),
    lastCheckedAt: new Date(Date.now() - 100000000),
    failureCount: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  })

  describe('constructor', () => {
    it('registers SIGINT, SIGHUP, and SIGTERM handlers', () => {
      expect(fakeProcess.listenerCount('SIGINT')).to.equal(1)
      expect(fakeProcess.listenerCount('SIGHUP')).to.equal(1)
      expect(fakeProcess.listenerCount('SIGTERM')).to.equal(1)
    })

    it('registers uncaughtException and unhandledRejection handlers', () => {
      expect(fakeProcess.listenerCount('uncaughtException')).to.equal(1)
      expect(fakeProcess.listenerCount('unhandledRejection')).to.equal(1)
    })
  })

  describe('run', () => {
    let clock: Sinon.SinonFakeTimers

    beforeEach(() => {
      clock = Sinon.useFakeTimers()
    })

    afterEach(() => {
      worker.close()
      clock.restore()
    })

    it('sets up a 60-second interval that triggers onSchedule', async () => {
      settingsState.payments = { enabled: true } as any
      paymentsService.getPendingInvoices.resolves([])

      worker.run()
      await clock.tickAsync(60000)

      expect(maintenanceService.clearOldEvents).to.have.been.calledOnce
      expect(paymentsService.getPendingInvoices).to.have.been.calledOnce
    })
  })

  describe('applyReverificationOutcome', () => {
    it('marks verified on a successful outcome and resets failureCount', () => {
      const existing = verification({ isVerified: false, lastVerifiedAt: null, failureCount: 5 })

      const updated = applyReverificationOutcome(existing, { status: 'verified' })

      expect(updated.isVerified).to.be.true
      expect(updated.lastVerifiedAt).to.be.an.instanceOf(Date)
      expect(updated.failureCount).to.equal(0)
      expect(updated.lastCheckedAt).to.be.an.instanceOf(Date)
    })

    it('flips to unverified and nulls lastVerifiedAt on definitive mismatch', () => {
      const existing = verification({ failureCount: 2 })

      const updated = applyReverificationOutcome(existing, { status: 'mismatch' })

      expect(updated.isVerified).to.be.false
      expect(updated.lastVerifiedAt).to.be.null
      expect(updated.failureCount).to.equal(3)
    })

    it('flips to unverified and nulls lastVerifiedAt on malformed response', () => {
      const existing = verification()

      const updated = applyReverificationOutcome(existing, { status: 'invalid', reason: 'bad json' })

      expect(updated.isVerified).to.be.false
      expect(updated.lastVerifiedAt).to.be.null
    })

    it('preserves lastVerifiedAt/isVerified on transient errors', () => {
      const lastVerified = new Date(Date.now() - 10000)
      const existing = verification({ lastVerifiedAt: lastVerified, failureCount: 1 })

      const updated = applyReverificationOutcome(existing, { status: 'error', reason: 'ETIMEDOUT' })

      expect(updated.isVerified).to.equal(existing.isVerified)
      expect(updated.lastVerifiedAt).to.equal(lastVerified)
      expect(updated.failureCount).to.equal(2)
      expect(updated.lastCheckedAt).to.be.an.instanceOf(Date)
    })
  })

  describe('processNip05Reverifications', () => {
    it('returns early when nip05 settings are undefined', async () => {
      settingsState.nip05 = undefined

      await (worker as any).processNip05Reverifications(settingsState)

      expect(nip05VerificationRepository.findPendingVerifications).not.to.have.been.called
    })

    it('returns early when mode is disabled', async () => {
      settingsState.nip05!.mode = 'disabled'

      await (worker as any).processNip05Reverifications(settingsState)

      expect(nip05VerificationRepository.findPendingVerifications).not.to.have.been.called
    })

    it('does nothing when no pending verifications', async () => {
      nip05VerificationRepository.findPendingVerifications.resolves([])

      await (worker as any).processNip05Reverifications(settingsState)

      expect(nip05VerificationRepository.findPendingVerifications).to.have.been.calledOnceWithExactly(86400000, 20, 50)
      expect(verifyStub).not.to.have.been.called
    })

    it('re-verifies and updates successful verifications', async () => {
      const row = verification()
      nip05VerificationRepository.findPendingVerifications.resolves([row])
      verifyStub.resolves({ status: 'verified' })

      await (worker as any).processNip05Reverifications(settingsState)

      expect(verifyStub).to.have.been.calledOnceWithExactly('alice@example.com', 'a'.repeat(64))
      expect(nip05VerificationRepository.upsert).to.have.been.calledOnce

      const upsertArg = nip05VerificationRepository.upsert.firstCall.args[0]
      expect(upsertArg.isVerified).to.be.true
      expect(upsertArg.failureCount).to.equal(0)
      expect(upsertArg.lastVerifiedAt).to.be.an.instanceOf(Date)
    })

    it('increments failure count and nulls lastVerifiedAt on definitive mismatch', async () => {
      const row = verification({ pubkey: 'b'.repeat(64), nip05: 'bob@example.com', failureCount: 3 })
      nip05VerificationRepository.findPendingVerifications.resolves([row])
      verifyStub.resolves({ status: 'mismatch' })

      await (worker as any).processNip05Reverifications(settingsState)

      expect(nip05VerificationRepository.upsert).to.have.been.calledOnce
      const upsertArg = nip05VerificationRepository.upsert.firstCall.args[0]
      expect(upsertArg.isVerified).to.be.false
      expect(upsertArg.failureCount).to.equal(4)
      expect(upsertArg.lastVerifiedAt).to.be.null
    })

    it('preserves prior verification on transient network errors', async () => {
      const lastVerifiedAt = new Date(Date.now() - 10000)
      const row = verification({ pubkey: 'c'.repeat(64), nip05: 'carol@example.com', failureCount: 1, lastVerifiedAt })
      nip05VerificationRepository.findPendingVerifications.resolves([row])
      verifyStub.resolves({ status: 'error', reason: 'ETIMEDOUT' })

      await (worker as any).processNip05Reverifications(settingsState)

      expect(nip05VerificationRepository.upsert).to.have.been.calledOnce
      const upsertArg = nip05VerificationRepository.upsert.firstCall.args[0]
      expect(upsertArg.isVerified).to.be.true
      expect(upsertArg.lastVerifiedAt).to.equal(lastVerifiedAt)
      expect(upsertArg.failureCount).to.equal(2)
    })

    it('handles individual verification errors gracefully', async () => {
      const v1 = verification({ pubkey: 'a'.repeat(64) })
      const v2 = verification({ pubkey: 'b'.repeat(64), nip05: 'bob@example.com' })
      nip05VerificationRepository.findPendingVerifications.resolves([v1, v2])
      verifyStub.onFirstCall().rejects(new Error('network error'))
      verifyStub.onSecondCall().resolves({ status: 'verified' })

      await (worker as any).processNip05Reverifications(settingsState)

      expect(nip05VerificationRepository.upsert).to.have.been.calledOnce
      const upsertArg = nip05VerificationRepository.upsert.firstCall.args[0]
      expect(upsertArg.pubkey).to.equal('b'.repeat(64))
    })

    it('uses configured updateFrequency and maxFailures', async () => {
      settingsState.nip05!.verifyUpdateFrequency = 3600000
      settingsState.nip05!.maxConsecutiveFailures = 5

      await (worker as any).processNip05Reverifications(settingsState)

      expect(nip05VerificationRepository.findPendingVerifications).to.have.been.calledOnceWithExactly(3600000, 5, 50)
    })

    it('uses defaults when settings values are undefined', async () => {
      settingsState.nip05!.verifyUpdateFrequency = undefined
      settingsState.nip05!.maxConsecutiveFailures = undefined

      await (worker as any).processNip05Reverifications(settingsState)

      expect(nip05VerificationRepository.findPendingVerifications).to.have.been.calledOnceWithExactly(86400000, 20, 50)
    })

    it('processes in passive mode', async () => {
      settingsState.nip05!.mode = 'passive'
      const row = verification({ pubkey: 'c'.repeat(64), nip05: 'charlie@example.com' })
      nip05VerificationRepository.findPendingVerifications.resolves([row])
      verifyStub.resolves({ status: 'verified' })

      await (worker as any).processNip05Reverifications(settingsState)

      expect(verifyStub).to.have.been.calledOnce
      expect(nip05VerificationRepository.upsert).to.have.been.calledOnce
    })
  })

  describe('onSchedule', () => {
    it('calls maintenance service and processes invoices', async () => {
      settingsState.payments = { enabled: true } as any
      maintenanceService.clearOldEvents.resolves()
      paymentsService.getPendingInvoices.resolves([])

      await (worker as any).onSchedule()

      expect(maintenanceService.clearOldEvents).to.have.been.calledOnce
      expect(paymentsService.getPendingInvoices).to.have.been.calledOnce
    })

    it('calls maintenance service even if payments are disabled', async () => {
      settingsState.payments = { enabled: false } as any
      maintenanceService.clearOldEvents.resolves()

      await (worker as any).onSchedule()

      expect(maintenanceService.clearOldEvents).to.have.been.calledOnce
      expect(paymentsService.updateInvoiceStatus).not.to.have.been.called
      expect(paymentsService.getPendingInvoices).not.to.have.been.called
    })

    it('skips an invoice when the processor returns no id', async () => {
      settingsState.payments = { enabled: true } as any
      paymentsService.getPendingInvoices.resolves([pendingInvoice])
      paymentsService.getInvoiceFromPaymentsProcessor.resolves({ status: InvoiceStatus.PENDING })

      await (worker as any).onSchedule()

      expect(paymentsService.updateInvoiceStatus).not.to.have.been.called
    })

    it('skips an invoice when the processor returns no status', async () => {
      settingsState.payments = { enabled: true } as any
      paymentsService.getPendingInvoices.resolves([pendingInvoice])
      paymentsService.getInvoiceFromPaymentsProcessor.resolves({ id: 'inv-1' })

      await (worker as any).onSchedule()

      expect(paymentsService.updateInvoiceStatus).not.to.have.been.called
    })

    it('updates invoice status when id and status are valid', async () => {
      settingsState.payments = { enabled: true } as any
      paymentsService.getPendingInvoices.resolves([pendingInvoice])
      paymentsService.getInvoiceFromPaymentsProcessor.resolves({
        id: 'inv-1',
        status: InvoiceStatus.PENDING,
      })

      await (worker as any).onSchedule()

      expect(paymentsService.updateInvoiceStatus).to.have.been.calledOnceWithExactly({
        id: 'inv-1',
        status: InvoiceStatus.PENDING,
      })
      expect(paymentsService.confirmInvoice).not.to.have.been.called
    })

    it('does not confirm when status changes but is not COMPLETED', async () => {
      settingsState.payments = { enabled: true } as any
      paymentsService.getPendingInvoices.resolves([pendingInvoice])
      paymentsService.getInvoiceFromPaymentsProcessor.resolves({
        id: 'inv-1',
        status: InvoiceStatus.EXPIRED,
      })

      await (worker as any).onSchedule()

      expect(paymentsService.updateInvoiceStatus).to.have.been.calledOnce
      expect(paymentsService.confirmInvoice).not.to.have.been.called
    })

    it('does not confirm when status is COMPLETED but confirmedAt is missing', async () => {
      settingsState.payments = { enabled: true } as any
      paymentsService.getPendingInvoices.resolves([pendingInvoice])
      paymentsService.getInvoiceFromPaymentsProcessor.resolves({
        id: 'inv-1',
        status: InvoiceStatus.COMPLETED,
        confirmedAt: null,
      })

      await (worker as any).onSchedule()

      expect(paymentsService.updateInvoiceStatus).to.have.been.calledOnce
      expect(paymentsService.confirmInvoice).not.to.have.been.called
      expect(paymentsService.sendInvoiceUpdateNotification).not.to.have.been.called
    })

    it('confirms and notifies when status changes to COMPLETED with confirmedAt', async () => {
      const confirmedAt = new Date()
      settingsState.payments = { enabled: true } as any
      paymentsService.getPendingInvoices.resolves([pendingInvoice])
      paymentsService.getInvoiceFromPaymentsProcessor.resolves({
        id: 'inv-1',
        status: InvoiceStatus.COMPLETED,
        confirmedAt,
      })

      await (worker as any).onSchedule()

      expect(paymentsService.updateInvoiceStatus).to.have.been.calledOnce
      expect(paymentsService.confirmInvoice).to.have.been.calledOnce
      expect(paymentsService.sendInvoiceUpdateNotification).to.have.been.calledOnce

      const [confirmArg] = paymentsService.confirmInvoice.firstCall.args
      expect(confirmArg).to.include({ id: 'inv-1', status: InvoiceStatus.COMPLETED })
      expect(confirmArg.amountPaid).to.equal(pendingInvoice.amountRequested)
    })

    it('continues processing remaining invoices when one throws', async () => {
      const secondInvoice = { ...pendingInvoice, id: 'inv-2' }
      settingsState.payments = { enabled: true } as any
      paymentsService.getPendingInvoices.resolves([pendingInvoice, secondInvoice])
      paymentsService.getInvoiceFromPaymentsProcessor
        .onFirstCall().rejects(new Error('processor error'))
        .onSecondCall().resolves({ id: 'inv-2', status: InvoiceStatus.PENDING })

      await (worker as any).onSchedule()

      expect(maintenanceService.clearOldEvents).to.have.been.calledOnce
      expect(paymentsService.updateInvoiceStatus).to.have.been.calledOnce
    })

    it('marks an expired pending invoice as expired when the payment processor returns 404', async () => {
      const expiredInvoice = {
        ...pendingInvoice,
        expiresAt: new Date(Date.now() - 60000),
      }
      const notFoundError = {
        response: { status: 404 },
      }
      settingsState.payments = { enabled: true } as any
      paymentsService.getPendingInvoices.resolves([expiredInvoice])
      paymentsService.getInvoiceFromPaymentsProcessor.rejects(notFoundError)

      await (worker as any).onSchedule()

      expect(paymentsService.updateInvoiceStatus).to.have.been.calledOnceWithExactly({
        id: expiredInvoice.id,
        status: InvoiceStatus.EXPIRED,
      })
    })

    it('keeps an expired pending invoice pending when the processor lookup fails without 404', async () => {
      const expiredInvoice = {
        ...pendingInvoice,
        expiresAt: new Date(Date.now() - 60000),
      }
      settingsState.payments = { enabled: true } as any
      paymentsService.getPendingInvoices.resolves([expiredInvoice])
      paymentsService.getInvoiceFromPaymentsProcessor.rejects(new Error('network error'))

      await (worker as any).onSchedule()

      expect(paymentsService.updateInvoiceStatus).not.to.have.been.called
    })

    it('keeps a non-expired pending invoice pending when the processor returns 404', async () => {
      const notFoundError = {
        response: { status: 404 },
      }
      settingsState.payments = { enabled: true } as any
      paymentsService.getPendingInvoices.resolves([pendingInvoice])
      paymentsService.getInvoiceFromPaymentsProcessor.rejects(notFoundError)

      await (worker as any).onSchedule()

      expect(paymentsService.updateInvoiceStatus).not.to.have.been.called
    })
  })

  describe('onError', () => {
    it('re-throws the error received from the process', () => {
      const err = new Error('uncaught error')

      expect(() => fakeProcess.emit('uncaughtException', err)).to.throw('uncaught error')
    })
  })

  describe('onExit', () => {
    it('calls close and then exits the process with code 0', () => {
      fakeProcess.emit('SIGTERM')

      expect(fakeProcess.exit).to.have.been.calledOnceWithExactly(0)
    })
  })

  describe('close', () => {
    it('invokes the callback when one is provided', () => {
      const callback = sandbox.stub()

      worker.close(callback)

      expect(callback).to.have.been.calledOnce
    })

    it('does not throw when called without a callback', () => {
      expect(() => worker.close()).not.to.throw()
    })
  })
})
