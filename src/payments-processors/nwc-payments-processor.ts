import { nwc } from '@getalby/sdk'
import { setTimeout as sleep } from 'node:timers/promises'

import { CreateInvoiceRequest, CreateInvoiceResponse, GetInvoiceResponse, IPaymentsProcessor } from '../@types/clients'
import { Factory } from '../@types/base'
import { Invoice, InvoiceStatus, InvoiceUnit } from '../@types/invoice'
import { Settings } from '../@types/settings'
import { createLogger } from '../factories/logger-factory'

const logger = createLogger('nwc-payments-processor')

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

const toSafeNumber = (value: bigint, fieldName: string): number => {
  if (value < 0n) {
    throw new Error(`${fieldName} must be a non-negative bigint.`)
  }

  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`${fieldName} exceeds Number.MAX_SAFE_INTEGER.`)
  }

  const asNumber = Number(value)
  if (!Number.isSafeInteger(asNumber)) {
    throw new Error(`${fieldName} is not a safe integer.`)
  }

  return asNumber
}

export class NwcInvoice implements Invoice {
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

export class NwcCreateInvoiceResponse implements CreateInvoiceResponse {
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

export class NwcPaymentsProcessor implements IPaymentsProcessor {
  public constructor(
    private nwcUrl: string,
    private replyTimeoutMs: number,
    private settings: Factory<Settings>,
  ) {}

  private withReplyTimeout = async <T>(operation: Promise<T>): Promise<T> => {
    const controller = new AbortController()
    const timeout = sleep(this.replyTimeoutMs, undefined, {
      ref: false,
      signal: controller.signal,
    })
      .then(() => {
        throw new nwc.Nip47ReplyTimeoutError(`reply timeout after ${this.replyTimeoutMs}ms`, 'INTERNAL')
      })
      .catch((error) => {
        if ((error as Error).name === 'AbortError') {
          return undefined as never
        }

        throw error
      })

    try {
      return await Promise.race([operation, timeout])
    } finally {
      controller.abort()
    }
  }

  private withClient = async <T>(fn: (client: nwc.NWCClient) => Promise<T>): Promise<T> => {
    const client = new nwc.NWCClient({ nostrWalletConnectUrl: this.nwcUrl })
    let caughtError: unknown

    try {
      return await fn(client)
    } catch (error) {
      caughtError = error
      throw error
    } finally {
      if (caughtError instanceof nwc.Nip47ReplyTimeoutError) {
        // The SDK can still emit a late response; this wait must not keep the process alive.
        await sleep(this.replyTimeoutMs + 100, undefined, { ref: false })
      }
      client.close()
    }
  }

  public async getInvoice(invoiceOrId: string | Invoice): Promise<GetInvoiceResponse> {
    const invoiceId = typeof invoiceOrId === 'string' ? invoiceOrId : invoiceOrId.id
    logger('get invoice: %s', invoiceId)

    try {
      return await this.withClient(async (client) => {
        const transaction = (await this.withReplyTimeout(
          client.lookupInvoice({ payment_hash: invoiceId }),
        )) as NwcTransaction
        const status = mapNwcStateToInvoiceStatus(transaction.state)

        const invoice: GetInvoiceResponse = {
          id: transaction.payment_hash || invoiceId,
          status,
          confirmedAt: status === InvoiceStatus.COMPLETED ? (timestampToDate(transaction.settled_at) ?? new Date()) : null,
          expiresAt: timestampToDate(transaction.expires_at),
          updatedAt: new Date(),
        }

        if (typeof invoiceOrId !== 'string') {
          invoice.pubkey = invoiceOrId.pubkey
          invoice.bolt11 = transaction.invoice || invoiceOrId.bolt11
          invoice.amountRequested =
            typeof transaction.amount === 'number' && Number.isFinite(transaction.amount)
              ? BigInt(Math.trunc(transaction.amount))
              : invoiceOrId.amountRequested
          invoice.amountPaid = status === InvoiceStatus.COMPLETED ? invoice.amountRequested : undefined
          invoice.unit = InvoiceUnit.MSATS
          invoice.description = transaction.description || invoiceOrId.description
          invoice.createdAt = timestampToDate(transaction.created_at) ?? invoiceOrId.createdAt
        } else {
          if (transaction.invoice) {
            invoice.bolt11 = transaction.invoice
          }
          if (typeof transaction.amount === 'number' && Number.isFinite(transaction.amount)) {
            invoice.amountRequested = BigInt(Math.trunc(transaction.amount))
            invoice.amountPaid = status === InvoiceStatus.COMPLETED ? invoice.amountRequested : undefined
            invoice.unit = InvoiceUnit.MSATS
          }
          if (transaction.description) {
            invoice.description = transaction.description
          }
          const createdAt = timestampToDate(transaction.created_at)
          if (createdAt) {
            invoice.createdAt = createdAt
          }
        }

        return invoice
      })
    } catch (error) {
      if (error instanceof nwc.Nip47WalletError || error instanceof nwc.Nip47ReplyTimeoutError) {
        logger('Unable to get NWC invoice %s. Reason: %s', invoiceId, error.message)
      } else {
        logger('Unable to get NWC invoice %s. Reason: %o', invoiceId, error)
      }
      throw error
    }
  }

  public async createInvoice(request: CreateInvoiceRequest): Promise<CreateInvoiceResponse> {
    logger('create invoice: %o', request)
    const { amount: amountMsats, description, requestId: pubkey } = request

    try {
      return await this.withClient(async (client) => {
        const expirySeconds = this.settings().paymentsProcessors?.nwc?.invoiceExpirySeconds
        const amount = toSafeNumber(amountMsats, 'CreateInvoiceRequest.amount')
        const transaction = (await this.withReplyTimeout(
          client.makeInvoice({
            amount,
            description,
            expiry: expirySeconds,
          }),
        )) as NwcTransaction

        const invoice = new NwcCreateInvoiceResponse()
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
        logger('Unable to request NWC invoice. Reason: %s', error.message)
      } else {
        logger('Unable to request NWC invoice. Reason: %o', error)
      }
      throw error
    }
  }
}
