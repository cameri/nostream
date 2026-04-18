import { IMaintenanceService, IPaymentsService } from '../@types/services'
import { mergeDeepLeft, path, pipe } from 'ramda'
import { IRunnable } from '../@types/base'

import { createLogger } from '../factories/logger-factory'
import { delayMs } from '../utils/misc'
import { InvoiceStatus } from '../@types/invoice'
import { Settings } from '../@types/settings'

const UPDATE_INVOICE_INTERVAL = 60000
const CLEAR_OLD_EVENTS_TIMEOUT_MS = 5000

const debug = createLogger('maintenance-worker')

export class MaintenanceWorker implements IRunnable {
  private interval: NodeJS.Timeout | undefined
  private isRunning = false

  public constructor(
    private readonly process: NodeJS.Process,
    private readonly paymentsService: IPaymentsService,
    private readonly maintenanceService: IMaintenanceService,
    private readonly settings: () => Settings,
  ) {
    this.process
      .on('SIGINT', this.onExit.bind(this))
      .on('SIGHUP', this.onExit.bind(this))
      .on('SIGTERM', this.onExit.bind(this))
      .on('uncaughtException', this.onError.bind(this))
      .on('unhandledRejection', this.onError.bind(this))
  }

  private async clearOldEventsSafely(): Promise<void> {
    try {
      await Promise.race([
        this.maintenanceService.clearOldEvents(),
        delayMs(CLEAR_OLD_EVENTS_TIMEOUT_MS).then(() => {
          throw new Error(`clearOldEvents timed out after ${CLEAR_OLD_EVENTS_TIMEOUT_MS}ms`)
        }),
      ])
    } catch (error) {
      debug('unable to clear old events: %o', error)
    }
  }

  public run(): void {
    this.interval = setInterval(async () => {
      if (this.isRunning) {
        debug('skipping scheduled maintenance run because previous run is still in progress')
        return
      }

      this.isRunning = true
      try {
        await this.onSchedule()
      } catch (error) {
        this.onError(error as Error)
      } finally {
        this.isRunning = false
      }
    }, UPDATE_INVOICE_INTERVAL)
  }

  private async onSchedule(): Promise<void> {
    const currentSettings = this.settings()
    const clearOldEventsPromise = this.clearOldEventsSafely()

    if (!path(['payments','enabled'], currentSettings)) {
      await clearOldEventsPromise
      return
    }

    const invoices = await this.paymentsService.getPendingInvoices()
    debug('found %d pending invoices', invoices.length)
    const delay = () => delayMs(100 + Math.floor(Math.random() * 10))

    let successful = 0

    for (const invoice of invoices) {
      try {
        debug('getting invoice %s from payment processor: %o', invoice.id, invoice)
        const updatedInvoice = await this.paymentsService.getInvoiceFromPaymentsProcessor(invoice)
        await delay()
        debug('updating invoice status %s: %o', updatedInvoice.id, updatedInvoice)

        if (typeof updatedInvoice.id !== 'string' || typeof updatedInvoice.status !== 'string') {
          continue
        }
        const { id, status } = updatedInvoice

        await this.paymentsService.updateInvoiceStatus({ id, status })

        if (
          invoice.status !== updatedInvoice.status
          && updatedInvoice.status == InvoiceStatus.COMPLETED
          && updatedInvoice.confirmedAt
        ) {
          debug('confirming invoice %s & notifying %s', invoice.id, invoice.pubkey)

          const update = pipe(
            mergeDeepLeft(updatedInvoice),
            mergeDeepLeft({ amountPaid: invoice.amountRequested }),
          )(invoice)

          await Promise.all([
            this.paymentsService.confirmInvoice(update),
            this.paymentsService.sendInvoiceUpdateNotification(update),
          ])

          await delay()
        }
        successful++
      } catch (error) {
        console.error('Unable to update invoice from payment processor. Reason:', error)
      }

      debug('updated %d of %d invoices successfully', successful, invoices.length)
    }

    await clearOldEventsPromise
  }

  private onError(error: Error) {
    debug('error: %o', error)
    throw error
  }

  private onExit() {
    debug('exiting')
    this.close(() => {
      this.process.exit(0)
    })
  }

  public close(callback?: () => void) {
    debug('closing')
    clearInterval(this.interval)
    if (typeof callback === 'function') {
      callback()
    }
  }
}
