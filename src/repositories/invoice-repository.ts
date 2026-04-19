import { always, applySpec, head, ifElse, is, map, omit, pipe, prop, propSatisfies, toString } from 'ramda'

import { DBInvoice, Invoice, InvoiceStatus } from '../@types/invoice'
import { fromDBInvoice, toBuffer } from '../utils/transform'
import { createLogger } from '../factories/logger-factory'
import { DatabaseClient } from '../@types/base'
import { IInvoiceRepository } from '../@types/repositories'
import { randomUUID } from 'crypto'

const logger = createLogger('invoice-repository')

export class InvoiceRepository implements IInvoiceRepository {
  public constructor(private readonly dbClient: DatabaseClient) {}

  public async confirmInvoice(
    invoiceId: string,
    amountPaid: bigint,
    confirmedAt: Date,
    client: DatabaseClient = this.dbClient,
  ): Promise<void> {
    logger('confirming invoice %s at %s: %s', invoiceId, confirmedAt, amountPaid)

    try {
      await client.raw('select confirm_invoice(?, ?, ?)', [invoiceId, amountPaid.toString(), confirmedAt.toISOString()])
    } catch (error) {
      logger.error('Unable to confirm invoice. Reason:', error)

      throw error
    }
  }

  public async findById(id: string, client: DatabaseClient = this.dbClient): Promise<Invoice | undefined> {
    const [dbInvoice] = await client<DBInvoice>('invoices').where('id', id).select()

    if (!dbInvoice) {
      return
    }

    return fromDBInvoice(dbInvoice)
  }

  public async findPendingInvoices(offset = 0, limit = 10, client: DatabaseClient = this.dbClient): Promise<Invoice[]> {
    // Order by created_at ASC for deterministic FIFO polling: oldest pending
    // invoices are picked up first, and the scan is index-only against
    // invoices_pending_created_at_idx (partial on status = 'pending').
    const dbInvoices = await client<DBInvoice>('invoices')
      .where('status', InvoiceStatus.PENDING)
      .orderBy('created_at', 'asc')
      .offset(offset)
      .limit(limit)
      .select()

    return dbInvoices.map(fromDBInvoice)
  }

  public updateStatus(invoice: Invoice, client: DatabaseClient = this.dbClient): Promise<Invoice | undefined> {
    logger('updating invoice status: %o', invoice)

    const query = client<DBInvoice>('invoices')
      .update({
        status: invoice.status,
        updated_at: new Date(),
      })
      .where('id', invoice.id)
      .limit(1)
      .returning(['*'])

    return {
      then: <T1, T2>(
        onfulfilled: (value: Invoice | undefined) => T1 | PromiseLike<T1>,
        onrejected: (reason: any) => T2 | PromiseLike<T2>,
      ) => query.then(pipe(map(fromDBInvoice), head)).then(onfulfilled, onrejected),
      catch: <T>(onrejected: (reason: any) => T | PromiseLike<T>) => query.catch(onrejected),
      toString: (): string => query.toString(),
    } as Promise<Invoice | undefined>
  }

  public upsert(invoice: Invoice, client: DatabaseClient = this.dbClient): Promise<number> {
    logger('upserting invoice: %o', invoice)

    const row = applySpec<DBInvoice>({
      id: ifElse(propSatisfies(is(String), 'id'), prop('id'), always(randomUUID())),
      pubkey: pipe(prop('pubkey'), toBuffer),
      bolt11: prop('bolt11'),
      amount_requested: pipe(prop('amountRequested'), toString),
      // amount_paid: ifElse(propSatisfies(is(BigInt), 'amountPaid'), pipe(prop('amountPaid'), toString), always(null)),
      unit: prop('unit'),
      status: prop('status'),
      description: prop('description'),
      // confirmed_at: prop('confirmedAt'),
      expires_at: prop('expiresAt'),
      updated_at: always(new Date()),
      created_at: prop('createdAt'),
      verify_url: prop('verifyURL'),
    })(invoice)

    logger('row: %o', row)

    const query = client<DBInvoice>('invoices')
      .insert(row)
      .onConflict('id')
      .merge(
        omit([
          'id',
          'pubkey',
          'bolt11',
          'amount_requested',
          'unit',
          'description',
          'expires_at',
          'created_at',
          'verify_url',
        ])(row),
      )

    return {
      then: <T1, T2>(
        onfulfilled: (value: number) => T1 | PromiseLike<T1>,
        onrejected: (reason: any) => T2 | PromiseLike<T2>,
      ) => query.then(prop('rowCount') as () => number).then(onfulfilled, onrejected),
      catch: <T>(onrejected: (reason: any) => T | PromiseLike<T>) => query.catch(onrejected),
      toString: (): string => query.toString(),
    } as Promise<number>
  }
}
