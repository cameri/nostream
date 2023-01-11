import {
  applySpec,
  is,
  omit,
  pipe,
  prop,
  propSatisfies,
  toString,
  when,
} from 'ramda'

import { DBInvoice, Invoice } from '../@types/invoice'
import { fromDBInvoice, toBuffer } from '../utils/transform'
import { createLogger } from '../factories/logger-factory'
import { DatabaseClient } from '../@types/base'
import { IInvoiceRepository } from '../@types/repositories'

const debug = createLogger('invoice-repository')

export class InvoiceRepository implements IInvoiceRepository {
  public constructor(private readonly dbClient: DatabaseClient) { }

  public async findById(id: string): Promise<Invoice> {
    const [dbInvoice] = await this.dbClient<DBInvoice>('invoices').where('id', id).select()

    if (!dbInvoice) {
      return
    }

    return fromDBInvoice(dbInvoice)
  }

  public upsert(invoice: Invoice): Promise<number> {
    debug('upserting invoice: %o', invoice)

    const row = applySpec({
      id: when(propSatisfies(is(String), 'id'), prop('id')),
      pubkey: pipe(prop('pubkey'), toBuffer),
      amount_requested: pipe(prop('amountRequested'), toString),
      amount_paid: when(propSatisfies(is(BigInt), 'amountPaid'), pipe(prop('amountPaid'), toString)),
      unit: prop('unit'),
      status: prop('status'),
      description: prop('description'),
      confirmed_at: prop('confirmedAt'),
      expires_at: prop('expiresAt'),
    })(invoice)

    const query = this.dbClient('invoices')
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
        ])(row)
      )

    return {
      then: <T1, T2>(onfulfilled: (value: number) => T1 | PromiseLike<T1>, onrejected: (reason: any) => T2 | PromiseLike<T2>) => query.then(prop('rowCount') as () => number).then(onfulfilled, onrejected),
      catch: <T>(onrejected: (reason: any) => T | PromiseLike<T>) => query.catch(onrejected),
      toString: (): string => query.toString(),
    } as Promise<number>
  }
}
