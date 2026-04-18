import * as chai from 'chai'
import * as sinon from 'sinon'
import sinonChai from 'sinon-chai'

chai.use(sinonChai)

const { expect } = chai

import { IMaintenanceService, IPaymentsService } from '../../../src/@types/services'
import { MaintenanceWorker } from '../../../src/app/maintenance-worker'
import { Settings } from '../../../src/@types/settings'

describe('MaintenanceWorker', () => {
  let worker: MaintenanceWorker
  let sandbox: sinon.SinonSandbox
  let paymentsService: sinon.SinonStubbedInstance<IPaymentsService>
  let maintenanceService: sinon.SinonStubbedInstance<IMaintenanceService>
  let settings: sinon.SinonStub
  let processMock: any

  beforeEach(() => {
    sandbox = sinon.createSandbox()
    paymentsService = {
      getPendingInvoices: sandbox.stub(),
      getInvoiceFromPaymentsProcessor: sandbox.stub(),
      updateInvoiceStatus: sandbox.stub(),
      confirmInvoice: sandbox.stub(),
      sendInvoiceUpdateNotification: sandbox.stub(),
    } as any
    maintenanceService = {
      clearOldEvents: sandbox.stub(),
    } as any
    settings = sandbox.stub()
    processMock = {
      on: sandbox.stub().returnsThis(),
    }

    worker = new MaintenanceWorker(
      processMock as any,
      paymentsService as any,
      maintenanceService as any,
      settings as any,
    )
  })

  afterEach(() => {
    sandbox.restore()
  })

  describe('onSchedule', () => {
    it('calls maintenance service and processes invoices', async () => {
      const currentSettings: Settings = {
        info: {} as any,
        network: {} as any,
        payments: {
          enabled: true,
        } as any,
      }
      settings.returns(currentSettings)
      maintenanceService.clearOldEvents.resolves()
      paymentsService.getPendingInvoices.resolves([])

      await (worker as any).onSchedule()

      expect(maintenanceService.clearOldEvents).to.have.been.calledOnce
      expect(paymentsService.getPendingInvoices).to.have.been.calledOnce
    })

    it('calls maintenance service even if payments are disabled', async () => {
      const currentSettings: Settings = {
        info: {} as any,
        network: {} as any,
        payments: {
          enabled: false,
        } as any,
      }
      settings.returns(currentSettings)
      maintenanceService.clearOldEvents.resolves()

      await (worker as any).onSchedule()

      expect(maintenanceService.clearOldEvents).to.have.been.calledOnce
      expect(paymentsService.getPendingInvoices).not.to.have.been.called
    })
  })
})
