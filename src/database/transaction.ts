import { Knex } from 'knex'

import { DatabaseClient, DatabaseTransaction } from '../@types/base'
import { ITransaction } from '../@types/database'

export class Transaction implements ITransaction {
  private trx: Knex.Transaction<any, any[]>

  public constructor(
    private readonly dbClient: DatabaseClient,
  ) {}

  public async begin(): Promise<void> {
    this.trx = await this.dbClient.transaction(null, { isolationLevel: 'serializable' })
  }

  public get transaction (): DatabaseTransaction {
    if (!this.trx) {
      throw new Error('Unable to get transaction: transaction not started.')
    }
    return this.trx
  }

  public async commit(): Promise<any[]> {
    if (!this.trx) {
      throw new Error('Unable to get transaction: transaction not started.')
    }
    return this.trx.commit()
  }

  public async rollback(): Promise<any[]> {
    if (!this.trx) {
      throw new Error('Unable to get transaction: transaction not started.')
    }
    return this.trx.rollback()
  }
}