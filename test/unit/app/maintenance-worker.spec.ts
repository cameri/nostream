import EventEmitter from 'events'

import chai from 'chai'
import chaiAsPromised from 'chai-as-promised'
import Sinon from 'sinon'
import sinonChai from 'sinon-chai'

import * as misc from '../../../src/utils/misc'
import { IMaintenanceService, IPaymentsService } from '../../../src/@types/services'
import { InvoiceStatus, InvoiceUnit } from '../../../src/@types/invoice'
import { MaintenanceWorker } from '../../../src/app/maintenance-worker'

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

    paymentsService = {
      getPendingInvoices: sandbox.stub(),
      getInvoiceFromPaymentsProcessor: sandbox.stub(),
      updateInvoiceStatus: sandbox.stub().resolves(),
      confirmInvoice: sandbox.stub().resolves(),
      sendInvoiceUpdateNotification: sandbox.stub().resolves(),
    } as any

    maintenanceService = {
      clearOldEvents: sandbox.stub().resolves(),
    } as any

    settings = sandbox.stub()

    // Prevent real timeouts and randomized per-invoice delays.
    sandbox.stub(misc, 'delayMs').resolves()

    worker = new MaintenanceWorker(
      fakeProcess as any,
      paymentsService,
      maintenanceService,
      settings as any,
    )
  })

  afterEach(() => {
    sandbox.restore()
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
      settings.returns({ payments: { enabled: true } })
      paymentsService.getPendingInvoices.resolves([])

      worker.run()
      await clock.tickAsync(60000)

      expect(maintenanceService.clearOldEvents).to.have.been.calledOnce
      expect(paymentsService.getPendingInvoices).to.have.been.calledOnce
    })
  })

  describe('onSchedule', () => {
    it('calls maintenance service even when payments are disabled', async () => {
      settings.returns({ payments: { enabled: false } })

      await (worker as any).onSchedule()

      expect(maintenanceService.clearOldEvents).to.have.been.calledOnce
      expect(paymentsService.getPendingInvoices).not.to.have.been.called
    })

    it('fetches pending invoices when payments are enabled', async () => {
      settings.returns({ payments: { enabled: true } })
      paymentsService.getPendingInvoices.resolves([])

      await (worker as any).onSchedule()

      expect(maintenanceService.clearOldEvents).to.have.been.calledOnce
      expect(paymentsService.getPendingInvoices).to.have.been.calledOnce
    })

    it('skips an invoice when the processor returns no id', async () => {
      settings.returns({ payments: { enabled: true } })
      paymentsService.getPendingInvoices.resolves([pendingInvoice])
      paymentsService.getInvoiceFromPaymentsProcessor.resolves({ status: InvoiceStatus.PENDING })

      await (worker as any).onSchedule()

      expect(maintenanceService.clearOldEvents).to.have.been.calledOnce
      expect(paymentsService.updateInvoiceStatus).not.to.have.been.called
    })

    it('skips an invoice when the processor returns no status', async () => {
      settings.returns({ payments: { enabled: true } })
      paymentsService.getPendingInvoices.resolves([pendingInvoice])
      paymentsService.getInvoiceFromPaymentsProcessor.resolves({ id: 'inv-1' })

      await (worker as any).onSchedule()

      expect(paymentsService.updateInvoiceStatus).not.to.have.been.called
    })

    it('updates invoice status when id and status are valid', async () => {
      settings.returns({ payments: { enabled: true } })
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
      settings.returns({ payments: { enabled: true } })
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
      settings.returns({ payments: { enabled: true } })
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
      settings.returns({ payments: { enabled: true } })
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
      settings.returns({ payments: { enabled: true } })
      paymentsService.getPendingInvoices.resolves([pendingInvoice, secondInvoice])
      paymentsService.getInvoiceFromPaymentsProcessor
        .onFirstCall().rejects(new Error('processor error'))
        .onSecondCall().resolves({ id: 'inv-2', status: InvoiceStatus.PENDING })

      const consoleErrorStub = sandbox.stub(console, 'error')

      await (worker as any).onSchedule()

      expect(maintenanceService.clearOldEvents).to.have.been.calledOnce
      expect(consoleErrorStub).to.have.been.calledOnce
      expect(paymentsService.updateInvoiceStatus).to.have.been.calledOnce
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
