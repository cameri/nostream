import {
  always,
  applySpec,
  head,
  ifElse,
  is,
  map,
  omit,
  pipe,
  prop,
  propSatisfies,
  toString,
} from 'ramda'

import { DBInvoice, Invoice, InvoiceStatus } from '../@types/invoice'
import { fromDBInvoice, toBuffer } from '../utils/transform'
import { createLogger } from '../factories/logger-factory'
import { DatabaseClient } from '../@types/base'
import { IInvoiceRepository } from '../@types/repositories'
import { randomUUID } from 'crypto'

const debug = createLogger('invoice-repository')

export class InvoiceRepository implements IInvoiceRepository {
  public constructor(private readonly dbClient: DatabaseClient) { }

  public async confirmInvoice(
    invoiceId: string,
    amountPaid: bigint,
    confirmedAt: Date,
    client: DatabaseClient = this.dbClient,
  ): Promise<void> {
    debug('confirming invoice %s at %s: %s', invoiceId, confirmedAt, amountPaid)

    try {
      await client.raw(
        'select confirm_invoice(?, ?, ?)',
        [
          invoiceId,
          amountPaid.toString(),
          confirmedAt.toISOString(),
        ]
      )
    } catch (error) {
      console.error('Unable to confirm invoice. Reason:', error.message)

      throw error
    }
  }

  public async findById(
    id: string,
    client: DatabaseClient = this.dbClient,
  ): Promise<Invoice | undefined> {
    const [dbInvoice] = await client<DBInvoice>('invoices')
      .where('id', id)
      .select()

    if (!dbInvoice) {
      return
    }

    return fromDBInvoice(dbInvoice)
  }

  public async findPendingInvoices(
    offset = 0,
    limit = 10,
    client: DatabaseClient = this.dbClient,
  ): Promise<Invoice[]> {
    const dbInvoices = await client<DBInvoice>('invoices')
      .where('status', InvoiceStatus.PENDING)
      .offset(offset)
      .limit(limit)
      .select()

    return dbInvoices.map(fromDBInvoice)
  }

  public updateStatus(
    invoice: Invoice,
    client: DatabaseClient = this.dbClient,
  ): Promise<Invoice | undefined> {
    debug('updating invoice status: %o', invoice)

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
        onrejected: (reason: any) => T2 | PromiseLike<T2>
      ) => query.then(pipe(map(fromDBInvoice), head)).then(onfulfilled, onrejected),
      catch: <T>(onrejected: (reason: any) => T | PromiseLike<T>) => query.catch(onrejected),
      toString: (): string => query.toString(),
    } as Promise<Invoice | undefined>
  }

  public upsert(
    invoice: Invoice,
    client: DatabaseClient = this.dbClient
  ): Promise<number> {
    debug('upserting invoice: %o', invoice)

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

    debug('row: %o', row)

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
        ])(row)
      )

    return {
      then: <T1, T2>(onfulfilled: (value: number) => T1 | PromiseLike<T1>, onrejected: (reason: any) => T2 | PromiseLike<T2>) => query.then(prop('rowCount') as () => number).then(onfulfilled, onrejected),
      catch: <T>(onrejected: (reason: any) => T | PromiseLike<T>) => query.catch(onrejected),
      toString: (): string => query.toString(),
    } as Promise<number>
  }
}
