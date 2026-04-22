import { always, applySpec, defaultTo, omit, pipe, prop } from 'ramda'
import { DatabaseClient, Pubkey } from '../@types/base'
import { DBUser, User } from '../@types/user'
import { fromDBUser, toBuffer } from '../utils/transform'
import { IEventRepository, IUserRepository } from '../@types/repositories'
import { createLogger } from '../factories/logger-factory'

const logger = createLogger('user-repository')

export class UserRepository implements IUserRepository {
  public constructor(
    private readonly dbClient: DatabaseClient,
    private readonly eventRepository: IEventRepository,
  ) {}

  public async findByPubkey(pubkey: Pubkey, client: DatabaseClient = this.dbClient): Promise<User | undefined> {
    logger('find by pubkey: %s', pubkey)
    const [dbuser] = await client<DBUser>('users').where('pubkey', toBuffer(pubkey)).select()

    if (!dbuser) {
      return
    }

    return fromDBUser(dbuser)
  }

  public async upsert(user: Partial<User>, client: DatabaseClient = this.dbClient): Promise<number> {
    logger('upsert: %o', user)

    const date = new Date()

    const row = applySpec<DBUser>({
      pubkey: pipe(prop('pubkey'), toBuffer),
      is_admitted: pipe(prop('isAdmitted'), defaultTo(false)),
      is_vanished: pipe(prop('isVanished'), defaultTo(false)),
      tos_accepted_at: prop('tosAcceptedAt'),
      updated_at: always(date),
      created_at: always(date),
    })(user)

    const query = client<DBUser>('users')
      .insert(row)
      .onConflict('pubkey')
      .merge(omit(['pubkey', 'balance', 'created_at'])(row))

    return {
      then: <T1, T2>(
        onfulfilled: (value: number) => T1 | PromiseLike<T1>,
        onrejected: (reason: any) => T2 | PromiseLike<T2>,
      ) => query.then(prop('rowCount') as () => number).then(onfulfilled, onrejected),
      catch: <T>(onrejected: (reason: any) => T | PromiseLike<T>) => query.catch(onrejected),
      toString: (): string => query.toString(),
    } as Promise<number>
  }

  /**
   * Returns vanish state from users.is_vanished, or lazily hydrates a user row from events once
   * when no users row exists (single upsert; no duplicate inserts).
   */
  public async isVanished(pubkey: Pubkey, client: DatabaseClient = this.dbClient): Promise<boolean> {
    const existing = await this.findByPubkey(pubkey, client)
    if (existing) {
      return existing.isVanished
    }

    const vanishedFromEvents = await this.eventRepository.hasActiveRequestToVanish(pubkey)
    await this.upsertVanishState(pubkey, vanishedFromEvents, client)
    return vanishedFromEvents
  }

  public setVanished(pubkey: Pubkey, vanished: boolean, client: DatabaseClient = this.dbClient): Promise<number> {
    return this.upsertVanishState(pubkey, vanished, client)
  }

  private upsertVanishState(pubkey: Pubkey, isVanished: boolean, client: DatabaseClient): Promise<number> {
    logger('upsert vanish state for %s: %o', pubkey, isVanished)
    const date = new Date()

    const query = client<DBUser>('users')
      .insert({
        pubkey: toBuffer(pubkey),
        is_admitted: false,
        balance: 0n,
        is_vanished: isVanished,
        created_at: date,
        updated_at: date,
      })
      .onConflict('pubkey')
      .merge({
        is_vanished: isVanished,
        updated_at: date,
      })

    return {
      then: <T1, T2>(
        onfulfilled: (value: number) => T1 | PromiseLike<T1>,
        onrejected: (reason: any) => T2 | PromiseLike<T2>,
      ) => query.then(prop('rowCount') as () => number).then(onfulfilled, onrejected),
      catch: <T>(onrejected: (reason: any) => T | PromiseLike<T>) => query.catch(onrejected),
      toString: (): string => query.toString(),
    } as Promise<number>
  }

  public async getBalanceByPubkey(pubkey: Pubkey, client: DatabaseClient = this.dbClient): Promise<bigint> {
    logger('get balance for pubkey: %s', pubkey)

    const [user] = await client<DBUser>('users').select('balance').where('pubkey', toBuffer(pubkey)).limit(1)

    if (!user) {
      return 0n
    }

    return BigInt(user.balance)
  }

  public async admitUser(pubkey: Pubkey, admittedAt: Date, client: DatabaseClient = this.dbClient): Promise<void> {
    logger('admit user: %s at %s', pubkey, admittedAt)

    try {
      await client.raw('select admit_user(?, ?)', [toBuffer(pubkey), admittedAt.toISOString()])
    } catch (error) {
      logger.error('Unable to admit user. Reason:', error)

      throw error
    }
  }
}
