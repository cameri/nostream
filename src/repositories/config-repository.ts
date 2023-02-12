import { always, applySpec, omit, prop } from 'ramda'

import { Config, DBConfig } from '../@types/config'
import { createLogger } from '../factories/logger-factory'
import { DatabaseClient } from '../@types/base'
import { fromDBConfig } from '../utils/transform'
import { IConfigRepository } from '../@types/repositories'

const debug = createLogger('config-repository')

export class ConfigRepository implements IConfigRepository {
  public constructor(private readonly dbClient: DatabaseClient) { }

  public async getConfig(
    key: string,
    client: DatabaseClient = this.dbClient
  ): Promise<Config | undefined> {
    debug('find config by key: %s', key)
    const [dbconfig] = await client<DBConfig>('configs')
      .where('key', key)
      .select()

    if (!dbconfig) {
      return
    }

    return fromDBConfig(dbconfig)
  }

  public async upsert(
    config: Config,
    client: DatabaseClient = this.dbClient,
  ): Promise<number> {
    debug('upsert: %o', config)

    const date = new Date()

    const row = applySpec<DBConfig>({
      key: prop('key'),
      value: prop('value'),
      category: prop('category'),
      updated_at: always(date),
      created_at: always(date),
    })(config)

    const query = client<DBConfig>('configs')
      .insert(row)
      .onConflict('key')
      .merge(
        omit([
          'value',
          'category',
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
