import { andThen, otherwise, pipe } from 'ramda'
import { broadcastEvent, getPublicKey, getRelayPrivateKey, identifyEvent, signEvent } from '../utils/event'
import { DatabaseClient, Pubkey } from '../@types/base'
import { FeeSchedule, Settings } from '../@types/settings'
import { IEventRepository, IInvoiceRepository, IUserRepository } from '../@types/repositories'
import { Invoice, InvoiceStatus, InvoiceUnit } from '../@types/invoice'

import { Event, ExpiringEvent, UnidentifiedEvent } from '../@types/event'
import { EventExpirationTimeMetadataKey, EventKinds, EventTags } from '../constants/base'
import { createLogger } from '../factories/logger-factory'
import { IPaymentsProcessor } from '../@types/clients'
import { IPaymentsService } from '../@types/services'
import { Transaction } from '../database/transaction'

const debug = createLogger('payments-service')

export class PaymentsService implements IPaymentsService {
  public constructor(
    private readonly dbClient: DatabaseClient,
    private readonly paymentsProcessor: IPaymentsProcessor,
    private readonly userRepository: IUserRepository,
    private readonly invoiceRepository: IInvoiceRepository,
    private readonly eventRepository: IEventRepository,
    private readonly settings: () => Settings
  ) {}

  public async getPendingInvoices(): Promise<Invoice[]> {
    debug('get pending invoices')
    try {
      return await this.invoiceRepository.findPendingInvoices(0, 10)
    } catch (error) {
      console.log('Unable to get pending invoices.', error)

      throw error
    }
  }

  public async getInvoiceFromPaymentsProcessor(invoice: Invoice | string): Promise<Partial<Invoice>> {
    try {
      return await this.paymentsProcessor.getInvoice(
        typeof invoice === 'string' || invoice?.verifyURL ? invoice : invoice.id
      )
    } catch (error) {
      console.log('Unable to get invoice from payments processor. Reason:', error)

      throw error
    }
  }

  public async createInvoice(
    pubkey: Pubkey,
    amount: bigint,
    description: string,
  ): Promise<Invoice> {
    debug('create invoice for %s for %s: %s', pubkey, amount.toString(), description)
    const transaction = new Transaction(this.dbClient)

    try {
      await transaction.begin()

      await this.userRepository.upsert({ pubkey }, transaction.transaction)

      const invoiceResponse = await this.paymentsProcessor.createInvoice(
        {
          amount,
          description,
          requestId: pubkey,
        },
      )

      const date = new Date()

      await this.invoiceRepository.upsert(
        {
          id: invoiceResponse.id,
          pubkey,
          bolt11: invoiceResponse.bolt11,
          amountRequested: invoiceResponse.amountRequested,
          description: invoiceResponse.description,
          unit: invoiceResponse.unit,
          status: invoiceResponse.status,
          expiresAt: invoiceResponse.expiresAt,
          updatedAt: date,
          createdAt: date,
          verifyURL: invoiceResponse.verifyURL,
        },
        transaction.transaction,
      )

      await transaction.commit()

      return {
        id: invoiceResponse.id,
        pubkey,
        bolt11: invoiceResponse.bolt11,
        amountRequested: invoiceResponse.amountRequested,
        unit: invoiceResponse.unit,
        status: invoiceResponse.status,
        description,
        expiresAt: invoiceResponse.expiresAt,
        updatedAt: date,
        createdAt: invoiceResponse.createdAt,
        verifyURL: invoiceResponse.verifyURL,
      }
    } catch (error) {
      await transaction.rollback()
      console.error('Unable to create invoice:', error)

      throw error
    }
  }

  public async updateInvoice(invoice: Partial<Invoice>): Promise<void> {
    debug('update invoice %s: %o', invoice.id, invoice)
    try {
      await this.invoiceRepository.updateStatus({
        id: invoice.id,
        status: invoice.status,
      })
    } catch (error) {
      console.error('Unable to update invoice. Reason:', error)
      throw error
    }
  }

  public async updateInvoiceStatus(invoice: Pick<Invoice, 'id' | 'status'>): Promise<Invoice> {
    debug('update invoice %s: %o', invoice.id, invoice)
    try {
      return await this.invoiceRepository.updateStatus(invoice)
    } catch (error) {
      console.error('Unable to update invoice. Reason:', error)
      throw error
    }
  }

  public async confirmInvoice(
    invoice: Invoice,
  ): Promise<void> {
    debug('confirm invoice %s: %O', invoice.id, invoice)

    const transaction = new Transaction(this.dbClient)

    try {
      if (!invoice.confirmedAt) {
        throw new Error('Invoice confirmation date is not set')
      }
      if (invoice.status !== InvoiceStatus.COMPLETED) {
        throw new Error(`Invoice is not complete: ${invoice.status}`)
      }

      if (typeof invoice.amountPaid !== 'bigint') {
        throw new Error(`Invoice paid amount is not set: ${invoice.amountPaid}`)
      }

      await transaction.begin()

      await this.invoiceRepository.confirmInvoice(
        invoice.id,
        invoice.amountPaid,
        invoice.confirmedAt,
        transaction.transaction
      )

      const currentSettings = this.settings()

      let amountPaidMsat = invoice.amountPaid

      if (invoice.unit === InvoiceUnit.SATS) {
        amountPaidMsat *= 1000n
      } else if (invoice.unit === InvoiceUnit.BTC) {
        amountPaidMsat *= 1000n * 100000000n
      }

      const isApplicableFee = (feeSchedule: FeeSchedule) => feeSchedule.enabled
        && !feeSchedule.whitelists?.pubkeys?.some((prefix) => invoice.pubkey.startsWith(prefix))
      const admissionFeeSchedules = currentSettings.payments?.feeSchedules?.admission ?? []
      const admissionFeeAmount = admissionFeeSchedules
        .reduce((sum, feeSchedule) => {
          return sum + (isApplicableFee(feeSchedule) ? BigInt(feeSchedule.amount) : 0n)
        }, 0n)

        if (
          admissionFeeAmount > 0n
          && amountPaidMsat >= admissionFeeAmount
        ) {
          const date = new Date()
          // TODO: Convert to stored func
          await this.userRepository.upsert(
            {
              pubkey: invoice.pubkey,
              isAdmitted: true,
              tosAcceptedAt: date,
              updatedAt: date,
            },
            transaction.transaction,
          )
        }

      await transaction.commit()
    } catch (error) {
      console.error('Unable to confirm invoice. Reason:', error)
      await transaction.rollback()

      throw error
    }
  }

  public async sendInvoiceUpdateNotification(invoice: Invoice): Promise<void> {
    debug('invoice updated notification %s: %o', invoice.id, invoice)
    const currentSettings = this.settings()

    const {
      info: {
        relay_url: relayUrl,
      },
    } = currentSettings

    const relayPrivkey = getRelayPrivateKey(relayUrl)
    const relayPubkey = getPublicKey(relayPrivkey)

    let unit: string = invoice.unit
    let amount: bigint | undefined = invoice.amountPaid
    if (typeof amount === 'undefined') {
      const message = `Unable to notify user ${invoice.pubkey} for invoice ${invoice.id}`

      throw new Error(message)
    }

    if (invoice.unit === InvoiceUnit.MSATS) {
      amount /= 1000n
      unit = InvoiceUnit.SATS
    }

    const now = new Date()
    const expiration = new Date(now.getFullYear(), now.getMonth() + 1, now.getDate())

    const unsignedInvoiceEvent: UnidentifiedEvent & Pick<ExpiringEvent, typeof EventExpirationTimeMetadataKey> = {
      pubkey: relayPubkey,
      kind: EventKinds.INVOICE_UPDATE,
      created_at: Math.floor(now.getTime() / 1000),
      content: `Invoice paid: ${amount.toString()} ${unit}`,
      tags: [
        [EventTags.Pubkey, invoice.pubkey],
        [EventTags.Invoice, invoice.bolt11],
        [EventTags.Expiration, Math.floor(expiration.getTime() / 1000).toString()],
      ],
      [EventExpirationTimeMetadataKey]: expiration.getTime() / 1000,
    }

    const persistEvent = async (event: Event) => {
      await this.eventRepository.create(event)

      return event
    }

    const logError = (error: Error) => console.error('Unable to send notification', error)

    await pipe(
      identifyEvent,
      andThen(signEvent(relayPrivkey)),
      andThen(persistEvent),
      andThen(broadcastEvent),
      otherwise(logError),
    )(unsignedInvoiceEvent)
  }
}
