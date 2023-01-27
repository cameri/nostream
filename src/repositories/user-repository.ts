import { always, applySpec, omit, pipe, prop } from 'ramda'

import { DatabaseClient, Pubkey } from '../@types/base'
import { DBUser, User } from '../@types/user'
import { fromDBUser, toBuffer } from '../utils/transform'
import { createLogger } from '../factories/logger-factory'
import { IUserRepository } from '../@types/repositories'

const debug = createLogger('user-repository')

export class UserRepository implements IUserRepository {
  public constructor(private readonly dbClient: DatabaseClient) { }

  public async findByPubkey(
    pubkey: Pubkey,
    client: DatabaseClient = this.dbClient
  ): Promise<User | undefined> {
    debug('find by pubkey: %s', pubkey)
    const [dbuser] = await client<DBUser>('users')
      .where('pubkey', toBuffer(pubkey))
      .select()

    if (!dbuser) {
      return
    }

    return fromDBUser(dbuser)
  }

  public async upsert(
    user: User,
    client: DatabaseClient = this.dbClient,
  ): Promise<number> {
    debug('upsert: %o', user)

    const date = new Date()

    const row = applySpec<DBUser>({
      pubkey: pipe(prop('pubkey'), toBuffer),
      is_admitted: prop('isAdmitted'),
      tos_accepted_at: prop('tosAcceptedAt'),
      updated_at: always(date),
      created_at: always(date),
    })(user)

    const query = client<DBUser>('users')
      .insert(row)
      .onConflict('pubkey')
      .merge(
        omit([
          'pubkey',
          'balance',
          'created_at',
        ])(row)
      )

    return {
      then: <T1, T2>(onfulfilled: (value: number) => T1 | PromiseLike<T1>, onrejected: (reason: any) => T2 | PromiseLike<T2>) => query.then(prop('rowCount') as () => number).then(onfulfilled, onrejected),
      catch: <T>(onrejected: (reason: any) => T | PromiseLike<T>) => query.catch(onrejected),
      toString: (): string => query.toString(),
    } as Promise<number>
  }

  public async getBalanceByPubkey(
    pubkey: Pubkey,
    client: DatabaseClient = this.dbClient
  ): Promise<bigint> {
    debug('get balance for pubkey: %s', pubkey)

    const [user] = await client<DBUser>('users')
      .select('balance')
      .where('pubkey', toBuffer(pubkey))
      .limit(1)

    if (!user) {
      return 0n
    }

    return BigInt(user.balance)
  }
}
