import chai from 'chai'
import chaiAsPromised from 'chai-as-promised'
import Sinon from 'sinon'
import sinonChai from 'sinon-chai'

chai.use(sinonChai)
chai.use(chaiAsPromised)

const { expect } = chai

import * as miscUtils from '../../../src/utils/misc'
import { InvoiceStatus, InvoiceUnit } from '../../../src/@types/invoice'
import { MaintenanceWorker } from '../../../src/app/maintenance-worker'
import { Settings } from '../../../src/@types/settings'

describe('MaintenanceWorker', () => {
  let sandbox: Sinon.SinonSandbox
  let worker: MaintenanceWorker
  let mockProcess: any
  let paymentsService: any
  let settingsFn: Sinon.SinonStub
  let clock: Sinon.SinonFakeTimers

  beforeEach(() => {
    sandbox = Sinon.createSandbox()
    sandbox.stub(miscUtils, 'delayMs').resolves()
    clock = sandbox.useFakeTimers()

    mockProcess = {
      on: sandbox.stub().returnsThis(),
      exit: sandbox.stub(),
    }

    paymentsService = {
      getPendingInvoices: sandbox.stub().resolves([]),
      getInvoiceFromPaymentsProcessor: sandbox.stub(),
      updateInvoiceStatus: sandbox.stub().resolves(),
      confirmInvoice: sandbox.stub().resolves(),
      sendInvoiceUpdateNotification: sandbox.stub().resolves(),
    }

    settingsFn = sandbox.stub().returns({
      payments: {
        enabled: true,
        processor: 'lnbits',
        feeSchedules: { admission: [], publication: [] },
      },
    } as unknown as Settings)

    worker = new MaintenanceWorker(
      mockProcess,
      paymentsService,
      settingsFn,
    )
  })

  afterEach(() => {
    worker.close()
    sandbox.restore()
  })

  describe('constructor', () => {
    it('registers signal and error handlers on process', () => {
      const events = mockProcess.on.args.map((args: any[]) => args[0])
      expect(events).to.include('SIGINT')
      expect(events).to.include('SIGHUP')
      expect(events).to.include('SIGTERM')
      expect(events).to.include('uncaughtException')
      expect(events).to.include('unhandledRejection')
    })
  })

  describe('run', () => {
    it('sets an interval that triggers onSchedule', async () => {
      paymentsService.getPendingInvoices.resolves([])
      worker.run()

      await clock.tickAsync(60000)

      expect(paymentsService.getPendingInvoices).to.have.been.calledOnce
    })
  })

  describe('onSchedule (via interval)', () => {
    beforeEach(() => {
      worker.run()
    })

    it('does nothing when payments.enabled is false', async () => {
      settingsFn.returns({ payments: { enabled: false } })

      await clock.tickAsync(60000)

      expect(paymentsService.getPendingInvoices).not.to.have.been.called
    })

    it('does nothing when payments is undefined', async () => {
      settingsFn.returns({})

      await clock.tickAsync(60000)

      expect(paymentsService.getPendingInvoices).not.to.have.been.called
    })

    it('gets pending invoices and processes each one', async () => {
      const invoices = [
        { id: 'inv1', status: InvoiceStatus.PENDING, amountRequested: 1000n },
        { id: 'inv2', status: InvoiceStatus.PENDING, amountRequested: 2000n },
      ]
      paymentsService.getPendingInvoices.resolves(invoices)
      paymentsService.getInvoiceFromPaymentsProcessor.resolves({
        id: 'inv1',
        status: InvoiceStatus.PENDING,
      })

      await clock.tickAsync(60000)

      expect(paymentsService.getInvoiceFromPaymentsProcessor).to.have.been.calledTwice
    })

    it('skips invoice when updatedInvoice.id is not a string', async () => {
      const invoices = [
        { id: 'inv1', status: InvoiceStatus.PENDING, amountRequested: 1000n },
      ]
      paymentsService.getPendingInvoices.resolves(invoices)
      paymentsService.getInvoiceFromPaymentsProcessor.resolves({
        id: undefined,
        status: InvoiceStatus.PENDING,
      })

      await clock.tickAsync(60000)

      expect(paymentsService.updateInvoiceStatus).not.to.have.been.called
    })

    it('skips invoice when updatedInvoice.status is not a string', async () => {
      const invoices = [
        { id: 'inv1', status: InvoiceStatus.PENDING, amountRequested: 1000n },
      ]
      paymentsService.getPendingInvoices.resolves(invoices)
      paymentsService.getInvoiceFromPaymentsProcessor.resolves({
        id: 'inv1',
        status: undefined,
      })

      await clock.tickAsync(60000)

      expect(paymentsService.updateInvoiceStatus).not.to.have.been.called
    })

    it('calls updateInvoiceStatus for valid invoices', async () => {
      const invoices = [
        { id: 'inv1', status: InvoiceStatus.PENDING, amountRequested: 1000n },
      ]
      paymentsService.getPendingInvoices.resolves(invoices)
      paymentsService.getInvoiceFromPaymentsProcessor.resolves({
        id: 'inv1',
        status: InvoiceStatus.PENDING,
      })

      await clock.tickAsync(60000)

      expect(paymentsService.updateInvoiceStatus).to.have.been.calledOnceWithExactly({
        id: 'inv1',
        status: InvoiceStatus.PENDING,
      })
    })

    it('confirms and notifies when status changes to COMPLETED with confirmedAt', async () => {
      const invoices = [
        {
          id: 'inv1',
          pubkey: 'a'.repeat(64),
          status: InvoiceStatus.PENDING,
          amountRequested: 5000n,
          unit: InvoiceUnit.MSATS,
        },
      ]
      paymentsService.getPendingInvoices.resolves(invoices)
      paymentsService.getInvoiceFromPaymentsProcessor.resolves({
        id: 'inv1',
        status: InvoiceStatus.COMPLETED,
        confirmedAt: new Date('2024-12-01'),
      })

      await clock.tickAsync(60000)

      expect(paymentsService.confirmInvoice).to.have.been.calledOnce
      expect(paymentsService.sendInvoiceUpdateNotification).to.have.been.calledOnce
    })

    it('uses amountRequested as amountPaid fallback via mergeDeepLeft', async () => {
      const invoices = [
        {
          id: 'inv1',
          pubkey: 'a'.repeat(64),
          status: InvoiceStatus.PENDING,
          amountRequested: 5000n,
          unit: InvoiceUnit.MSATS,
        },
      ]
      paymentsService.getPendingInvoices.resolves(invoices)
      paymentsService.getInvoiceFromPaymentsProcessor.resolves({
        id: 'inv1',
        status: InvoiceStatus.COMPLETED,
        confirmedAt: new Date('2024-12-01'),
      })

      await clock.tickAsync(60000)

      const confirmedInvoice = paymentsService.confirmInvoice.firstCall.args[0]
      expect(confirmedInvoice.amountPaid).to.equal(5000n)
    })

    it('does not confirm when status has not changed', async () => {
      const invoices = [
        { id: 'inv1', status: InvoiceStatus.COMPLETED, amountRequested: 1000n },
      ]
      paymentsService.getPendingInvoices.resolves(invoices)
      paymentsService.getInvoiceFromPaymentsProcessor.resolves({
        id: 'inv1',
        status: InvoiceStatus.COMPLETED,
        confirmedAt: new Date('2024-12-01'),
      })

      await clock.tickAsync(60000)

      expect(paymentsService.confirmInvoice).not.to.have.been.called
    })

    it('does not confirm when status changed but no confirmedAt', async () => {
      const invoices = [
        { id: 'inv1', status: InvoiceStatus.PENDING, amountRequested: 1000n },
      ]
      paymentsService.getPendingInvoices.resolves(invoices)
      paymentsService.getInvoiceFromPaymentsProcessor.resolves({
        id: 'inv1',
        status: InvoiceStatus.COMPLETED,
      })

      await clock.tickAsync(60000)

      expect(paymentsService.confirmInvoice).not.to.have.been.called
    })

    it('catches per-invoice errors without stopping the loop', async () => {
      const invoices = [
        { id: 'inv1', status: InvoiceStatus.PENDING, amountRequested: 1000n },
        { id: 'inv2', status: InvoiceStatus.PENDING, amountRequested: 2000n },
      ]
      paymentsService.getPendingInvoices.resolves(invoices)
      paymentsService.getInvoiceFromPaymentsProcessor
        .onFirstCall().rejects(new Error('processor error'))
        .onSecondCall().resolves({ id: 'inv2', status: InvoiceStatus.PENDING })

      sandbox.stub(console, 'error')

      await clock.tickAsync(60000)

      // Second invoice should still be processed
      expect(paymentsService.getInvoiceFromPaymentsProcessor).to.have.been.calledTwice
      expect(paymentsService.updateInvoiceStatus).to.have.been.calledOnce
    })
  })

  describe('close', () => {
    it('calls callback if provided', () => {
      const callback = sandbox.stub()
      worker.close(callback)

      expect(callback).to.have.been.calledOnce
    })

    it('does not throw if callback is undefined', () => {
      expect(() => worker.close()).not.to.throw()
    })
  })

  describe('onError', () => {
    it('re-throws the error', () => {
      const errorHandler = mockProcess.on.args.find(
        (args: any[]) => args[0] === 'uncaughtException',
      )[1]

      expect(() => errorHandler(new Error('test error'))).to.throw('test error')
    })
  })

  describe('onExit', () => {
    it('calls close and process.exit(0)', () => {
      const exitHandler = mockProcess.on.args.find(
        (args: any[]) => args[0] === 'SIGINT',
      )[1]

      exitHandler()

      expect(mockProcess.exit).to.have.been.calledOnceWithExactly(0)
    })
  })
})
