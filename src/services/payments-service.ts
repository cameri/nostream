import { andThen, pipe } from 'ramda'

import { broadcastEvent, encryptKind4Event, getPrivateKeyFromSecret, getPublicKey, identifyEvent, signEvent } from '../utils/event'
import { DatabaseClient, Pubkey } from '../@types/base'
import { FeeSchedule, Settings } from '../@types/settings'
import { IEventRepository, IInvoiceRepository, IUserRepository } from '../@types/repositories'
import { Invoice, InvoiceStatus, InvoiceUnit } from '../@types/invoice'
import { createLogger } from '../factories/logger-factory'
import { EventKinds } from '../constants/base'
import { IPaymentsProcessor } from '../@types/clients'
import { IPaymentsService } from '../@types/services'
import { toBech32 } from '../utils/transform'
import { Transaction } from '../database/transaction'
import { UnidentifiedEvent } from '../@types/event'

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

  public async getInvoiceFromPaymentsProcessor(invoiceId: string): Promise<Invoice> {
    debug('get invoice %s from payment processor', invoiceId)
    try {
      return await this.paymentsProcessor.getInvoice(invoiceId)
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
    debug('create invoice for %s for %s: %d', pubkey, amount.toString(), description)
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
      }
    } catch (error) {
      await transaction.rollback()
      console.error('Unable to create invoice:', error)

      throw error
    }
  }

  public async updateInvoice(invoice: Invoice): Promise<void> {
    debug('update invoice %s: %o', invoice.id, invoice)
    try {
      await this.invoiceRepository.upsert({
        id: invoice.id,
        pubkey: invoice.pubkey,
        bolt11: invoice.bolt11,
        amountRequested: invoice.amountRequested,
        description: invoice.description,
        unit: invoice.unit,
        status: invoice.status,
        expiresAt: invoice.expiresAt,
        updatedAt: new Date(),
        createdAt: invoice.createdAt,
      })
    } catch (error) {
      console.error('Unable to update invoice. Reason:', error)
      throw error
    }
  }

  public async confirmInvoice(
    invoice: Invoice,
  ): Promise<void> {
    debug('confirm invoice %s: %o', invoice.id, invoice)

    const transaction = new Transaction(this.dbClient)

    try {
      if (!invoice.confirmedAt) {
        throw new Error('Invoince confirmation date is not set')
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

      const isApplicableFee = (feeSchedule: FeeSchedule) => feeSchedule.enabled
        && !feeSchedule.whitelists?.pubkeys?.some((prefix) => invoice.pubkey.startsWith(prefix))
      const admissionFeeSchedules = currentSettings.payments?.feeSchedules?.admission ?? []
      const admissionFeeAmount = admissionFeeSchedules
        .reduce((sum, feeSchedule) => {
          return sum + (isApplicableFee(feeSchedule) ? BigInt(feeSchedule.amount) : 0n)
        }, 0n)

        if (
          admissionFeeAmount > 0n
          && invoice.amountPaid >= admissionFeeAmount
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

  public async sendNewInvoiceNotification(invoice: Invoice): Promise<void> {
    debug('invoice created notification %s: %o', invoice.id, invoice)
    const currentSettings = this.settings()

    const {
      info: {
        relay_url: relayUrl,
        name: relayName,
      },
    } = currentSettings

    const relayPrivkey = getPrivateKeyFromSecret(process.env.SECRET as string)(relayUrl)
    const relayPubkey = getPublicKey(relayPrivkey)

    let unit: string = invoice.unit
    let amount: bigint = invoice.amountRequested
    if (invoice.unit === InvoiceUnit.MSATS) {
      amount /= 1000n
      unit = 'sats'
    }

    const url = new URL(relayUrl)

    const terms = new URL(relayUrl)
    terms.protocol = ['https', 'wss'].includes(url.protocol)
      ? 'https'
      : 'http'
    terms.pathname += 'terms'

    const unsignedInvoiceEvent: UnidentifiedEvent = {
      pubkey: relayPubkey,
      kind: EventKinds.ENCRYPTED_DIRECT_MESSAGE,
      created_at: Math.floor(invoice.createdAt.getTime() / 1000),
      content: `From: ${toBech32('npub')(relayPubkey)}@${url.hostname} (${relayName})
To: ${toBech32('npub')(invoice.pubkey)}@${url.hostname}
🧾 Admission Fee Invoice

Amount: ${amount.toString()} ${unit}

⚠️ By paying this invoice, you confirm that you have read and agree to the Terms of Service:
${terms.toString()}
${invoice.expiresAt ? `
⏳ Expires at ${invoice.expiresAt.toISOString()}` : ''}

${invoice.bolt11}`,
      tags: [
        ['p', invoice.pubkey],
        ['bolt11', invoice.bolt11],
      ],
    }

    const persistEvent = this.eventRepository.create.bind(this.eventRepository)

    await pipe(
      identifyEvent,
      andThen(encryptKind4Event(relayPrivkey, invoice.pubkey)),
      andThen(signEvent(relayPrivkey)),
      andThen(broadcastEvent),
      andThen(persistEvent),
    )(unsignedInvoiceEvent)
  }

  public async sendInvoiceUpdateNotification(invoice: Invoice): Promise<void> {
    debug('invoice updated notification %s: %o', invoice.id, invoice)
    const currentSettings = this.settings()

    const {
      info: {
        relay_url: relayUrl,
        name: relayName,
      },
    } = currentSettings

    const relayPrivkey = getPrivateKeyFromSecret(process.env.SECRET as string)(relayUrl)
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

    const url = new URL(relayUrl)

    const unsignedInvoiceEvent: UnidentifiedEvent = {
      pubkey: relayPubkey,
      kind: EventKinds.ENCRYPTED_DIRECT_MESSAGE,
      created_at: Math.floor(invoice.createdAt.getTime() / 1000),
      content: `🧾 Admission Fee Invoice Paid for ${relayPubkey}@${url.hostname} (${relayName})

Amount received: ${amount.toString()} ${unit}

Thanks!`,
      tags: [
        ['p', invoice.pubkey],
        ['c', invoice.id],
      ],
    }

    const persistEvent = this.eventRepository.create.bind(this.eventRepository)

    await pipe(
      identifyEvent,
      andThen(encryptKind4Event(relayPrivkey, invoice.pubkey)),
      andThen(signEvent(relayPrivkey)),
      andThen(broadcastEvent),
      andThen(persistEvent),
    )(unsignedInvoiceEvent)
  }
}
