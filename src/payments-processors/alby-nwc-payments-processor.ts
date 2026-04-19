import { nwc } from '@getalby/sdk'

import { CreateInvoiceRequest, CreateInvoiceResponse, GetInvoiceResponse, IPaymentsProcessor } from '../@types/clients'
import { Factory } from '../@types/base'
import { Invoice, InvoiceStatus, InvoiceUnit } from '../@types/invoice'
import { Settings } from '../@types/settings'
import { createLogger } from '../factories/logger-factory'

const debug = createLogger('alby-nwc-payments-processor')

type NwcTransaction = {
  state?: 'settled' | 'pending' | 'expired' | 'failed' | 'accepted'
  invoice?: string
  payment_hash?: string
  amount?: number
  description?: string
  created_at?: number
  settled_at?: number
  expires_at?: number
}

const mapNwcStateToInvoiceStatus = (state?: NwcTransaction['state']): InvoiceStatus => {
  switch (state) {
    case 'settled':
      return InvoiceStatus.COMPLETED
    case 'expired':
    case 'failed':
      return InvoiceStatus.EXPIRED
    case 'accepted':
    case 'pending':
    default:
      return InvoiceStatus.PENDING
  }
}

const timestampToDate = (unixSeconds?: number): Date | null => {
  if (typeof unixSeconds === 'number' && Number.isFinite(unixSeconds) && unixSeconds > 0) {
    return new Date(unixSeconds * 1000)
  }

  return null
}

export class AlbyNwcInvoice implements Invoice {
  id: string
  pubkey: string
  bolt11: string
  amountRequested: bigint
  amountPaid?: bigint
  unit: InvoiceUnit
  status: InvoiceStatus
  description: string
  confirmedAt?: Date | null
  expiresAt: Date | null
  updatedAt: Date
  createdAt: Date
}

export class AlbyNwcCreateInvoiceResponse implements CreateInvoiceResponse {
  id: string
  pubkey: string
  bolt11: string
  amountRequested: bigint
  description: string
  unit: InvoiceUnit
  status: InvoiceStatus
  expiresAt: Date | null
  confirmedAt?: Date | null
  createdAt: Date
  rawResponse?: string
}

export class AlbyNwcPaymentsProcessor implements IPaymentsProcessor {
  public constructor(
    private nwcUrl: string,
    private replyTimeoutMs: number,
    private settings: Factory<Settings>,
  ) {}

  private withReplyTimeout = async <T>(operation: Promise<T>): Promise<T> => {
    let timeoutId: ReturnType<typeof setTimeout> | undefined

    try {
      return await Promise.race([
        operation,
        new Promise<never>((_, reject) => {
          timeoutId = setTimeout(() => {
            reject(new nwc.Nip47ReplyTimeoutError(`reply timeout after ${this.replyTimeoutMs}ms`, 'INTERNAL'))
          }, this.replyTimeoutMs)
        }),
      ])
    } finally {
      if (timeoutId) {
        clearTimeout(timeoutId)
      }
    }
  }

  private withClient = async <T>(fn: (client: nwc.NWCClient) => Promise<T>): Promise<T> => {
    const client = new nwc.NWCClient({ nostrWalletConnectUrl: this.nwcUrl })

    try {
      return await fn(client)
    } finally {
      client.close()
    }
  }

  public async getInvoice(invoiceOrId: string | Invoice): Promise<GetInvoiceResponse> {
    const invoiceId = typeof invoiceOrId === 'string' ? invoiceOrId : invoiceOrId.id
    debug('get invoice: %s', invoiceId)

    try {
      return await this.withClient(async (client) => {
        const transaction = (await this.withReplyTimeout(
          client.lookupInvoice({ payment_hash: invoiceId }),
        )) as NwcTransaction
        const status = mapNwcStateToInvoiceStatus(transaction.state)

        const invoice = new AlbyNwcInvoice()
        invoice.id = transaction.payment_hash || invoiceId
        invoice.pubkey = typeof invoiceOrId === 'string' ? '' : invoiceOrId.pubkey
        invoice.bolt11 = transaction.invoice || (typeof invoiceOrId === 'string' ? '' : invoiceOrId.bolt11)
        invoice.amountRequested =
          typeof transaction.amount === 'number' && Number.isFinite(transaction.amount)
            ? BigInt(Math.trunc(transaction.amount))
            : typeof invoiceOrId === 'string'
              ? 0n
              : invoiceOrId.amountRequested
        invoice.amountPaid = status === InvoiceStatus.COMPLETED ? invoice.amountRequested : undefined
        invoice.unit = InvoiceUnit.MSATS
        invoice.status = status
        invoice.description = transaction.description || (typeof invoiceOrId === 'string' ? '' : invoiceOrId.description)
        invoice.confirmedAt = status === InvoiceStatus.COMPLETED ? (timestampToDate(transaction.settled_at) ?? new Date()) : null
        invoice.expiresAt = timestampToDate(transaction.expires_at)
        invoice.createdAt = timestampToDate(transaction.created_at) ?? new Date()
        invoice.updatedAt = new Date()

        return invoice
      })
    } catch (error) {
      if (error instanceof nwc.Nip47WalletError || error instanceof nwc.Nip47ReplyTimeoutError) {
        console.error(`Unable to get Alby NWC invoice ${invoiceId}. Reason:`, error.message)
      } else {
        console.error(`Unable to get Alby NWC invoice ${invoiceId}. Reason:`, error)
      }
      throw error
    }
  }

  public async createInvoice(request: CreateInvoiceRequest): Promise<CreateInvoiceResponse> {
    debug('create invoice: %o', request)
    const { amount: amountMsats, description, requestId: pubkey } = request

    try {
      return await this.withClient(async (client) => {
        const expirySeconds = this.settings().paymentsProcessors?.alby?.invoiceExpirySeconds
        const transaction = (await this.withReplyTimeout(
          client.makeInvoice({
            amount: Number(amountMsats),
            description,
            expiry: expirySeconds,
          }),
        )) as NwcTransaction

        const invoice = new AlbyNwcCreateInvoiceResponse()
        invoice.id = transaction.payment_hash || ''
        invoice.pubkey = pubkey
        invoice.bolt11 = transaction.invoice || ''
        invoice.amountRequested =
          typeof transaction.amount === 'number' && Number.isFinite(transaction.amount)
            ? BigInt(Math.trunc(transaction.amount))
            : amountMsats
        invoice.description = transaction.description || description || ''
        invoice.unit = InvoiceUnit.MSATS
        invoice.status = mapNwcStateToInvoiceStatus(transaction.state)
        invoice.confirmedAt = invoice.status === InvoiceStatus.COMPLETED ? (timestampToDate(transaction.settled_at) ?? new Date()) : null
        invoice.expiresAt = timestampToDate(transaction.expires_at)
        invoice.createdAt = timestampToDate(transaction.created_at) ?? new Date()
        invoice.rawResponse = JSON.stringify(transaction)

        return invoice
      })
    } catch (error) {
      if (error instanceof nwc.Nip47WalletError || error instanceof nwc.Nip47ReplyTimeoutError) {
        console.error('Unable to request Alby NWC invoice. Reason:', error.message)
      } else {
        console.error('Unable to request Alby NWC invoice. Reason:', error)
      }
      throw error
    }
  }
}
