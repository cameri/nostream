import {
  DEFAULT_NIP05_MAX_CONSECUTIVE_FAILURES,
  DEFAULT_NIP05_VERIFY_UPDATE_FREQUENCY_MS,
  Nip05VerificationOutcome,
  verifyNip05Identifier,
} from '../utils/nip05'
import { IMaintenanceService, IPaymentsService } from '../@types/services'
import { mergeDeepLeft, path, pipe } from 'ramda'
import { IRunnable } from '../@types/base'

import { createLogger } from '../factories/logger-factory'
import { delayMs } from '../utils/misc'
import { INip05VerificationRepository } from '../@types/repositories'
import { InvoiceStatus } from '../@types/invoice'
import { isExpiredInvoice } from '../utils/invoice'
import { Nip05Verification } from '../@types/nip05'
import { Settings } from '../@types/settings'

const UPDATE_INVOICE_INTERVAL = 60000
const NIP05_REVERIFICATION_BATCH_SIZE = 50
const CLEAR_OLD_EVENTS_TIMEOUT_MS = 5000

const logger = createLogger('maintenance-worker')

const isNotFoundError = (error: unknown): boolean =>
  (error as any)?.response?.status === 404

/**
 * Merge a re-verification outcome onto an existing verification row.
 *
 * Definitive outcomes (`verified`, `mismatch`, `invalid`) update `isVerified`
 * and `lastVerifiedAt`. Transient `error` outcomes only bump `failureCount` /
 * `lastCheckedAt` so a previously-verified author keeps their grace period
 * until `verifyExpiration` elapses. This prevents a single network blip from
 * immediately blocking publishing.
 */
export function applyReverificationOutcome(
  existing: Nip05Verification,
  outcome: Nip05VerificationOutcome,
): Nip05Verification {
  const now = new Date()
  const base: Nip05Verification = {
    ...existing,
    lastCheckedAt: now,
    updatedAt: now,
  }

  switch (outcome.status) {
    case 'verified':
      return {
        ...base,
        isVerified: true,
        lastVerifiedAt: now,
        failureCount: 0,
      }
    case 'mismatch':
    case 'invalid':
      return {
        ...base,
        isVerified: false,
        lastVerifiedAt: null,
        failureCount: existing.failureCount + 1,
      }
    case 'error':
    default:
      return {
        ...base,
        failureCount: existing.failureCount + 1,
      }
  }
}

export class MaintenanceWorker implements IRunnable {
  private interval: NodeJS.Timeout | undefined
  private isRunning = false

  public constructor(
    private readonly process: NodeJS.Process,
    private readonly paymentsService: IPaymentsService,
    private readonly maintenanceService: IMaintenanceService,
    private readonly settings: () => Settings,
    private readonly nip05VerificationRepository: INip05VerificationRepository,
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
      logger('unable to clear old events: %o', error)
    }
  }

  public run(): void {
    this.interval = setInterval(async () => {
      if (this.isRunning) {
        logger('skipping scheduled maintenance run because previous run is still in progress')
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

    await this.processNip05Reverifications(currentSettings)

    if (!path(['payments', 'enabled'], currentSettings)) {
      await clearOldEventsPromise
      return
    }

    const invoices = await this.paymentsService.getPendingInvoices()
    logger('found %d pending invoices', invoices.length)
    const delay = () => delayMs(100 + Math.floor(Math.random() * 10))

    let successful = 0

    for (const invoice of invoices) {
      try {
        logger('getting invoice %s from payment processor: %o', invoice.id, invoice)
        const updatedInvoice = await this.paymentsService.getInvoiceFromPaymentsProcessor(invoice)
        await delay()
        logger('updating invoice status %s: %o', updatedInvoice.id, updatedInvoice)

        if (typeof updatedInvoice.id !== 'string' || typeof updatedInvoice.status !== 'string') {
          continue
        }
        const { id, status } = updatedInvoice

        await this.paymentsService.updateInvoiceStatus({ id, status })

        if (
          invoice.status !== updatedInvoice.status &&
          updatedInvoice.status == InvoiceStatus.COMPLETED &&
          updatedInvoice.confirmedAt
        ) {
          logger('confirming invoice %s & notifying %s', invoice.id, invoice.pubkey)

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
        if (isNotFoundError(error) && isExpiredInvoice(invoice)) {
          logger('marking expired invoice %s after payment processor returned 404', invoice.id)
          await this.paymentsService.updateInvoiceStatus({
            id: invoice.id,
            status: InvoiceStatus.EXPIRED,
          })
          successful++
          continue
        }

        logger.error('Unable to update invoice from payment processor. Reason:', error)
      }

      logger('updated %d of %d invoices successfully', successful, invoices.length)
    }

    await clearOldEventsPromise
  }

  private async processNip05Reverifications(currentSettings: Settings): Promise<void> {
    const nip05Settings = currentSettings.nip05
    if (!nip05Settings || nip05Settings.mode === 'disabled') {
      return
    }

    try {
      const updateFrequency = nip05Settings.verifyUpdateFrequency ?? DEFAULT_NIP05_VERIFY_UPDATE_FREQUENCY_MS
      const maxFailures = nip05Settings.maxConsecutiveFailures ?? DEFAULT_NIP05_MAX_CONSECUTIVE_FAILURES

      const pendingVerifications = await this.nip05VerificationRepository.findPendingVerifications(
        updateFrequency,
        maxFailures,
        NIP05_REVERIFICATION_BATCH_SIZE,
      )

      if (!pendingVerifications.length) {
        return
      }

      logger('found %d NIP-05 verifications to re-check', pendingVerifications.length)

      for (const verification of pendingVerifications) {
        try {
          const outcome = await verifyNip05Identifier(verification.nip05, verification.pubkey)
          const updated = applyReverificationOutcome(verification, outcome)
          await this.nip05VerificationRepository.upsert(updated)
          await delayMs(200 + Math.floor(Math.random() * 100))
        } catch (error) {
          logger('failed to re-verify NIP-05 for %s: %o', verification.pubkey, error)
        }
      }
    } catch (error) {
      logger('NIP-05 re-verification batch failed: %o', error)
    }
  }

  private onError(error: Error) {
    logger('error: %o', error)
    throw error
  }

  private onExit() {
    logger('exiting')
    this.close(() => {
      this.process.exit(0)
    })
  }

  public close(callback?: () => void) {
    logger('closing')
    clearInterval(this.interval)
    if (typeof callback === 'function') {
      callback()
    }
  }
}
