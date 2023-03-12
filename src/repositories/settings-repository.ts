import { always, applySpec, omit, prop } from 'ramda'

import { DBSetting, Setting } from '../@types/setting'
import { createLogger } from '../factories/logger-factory'
import { DatabaseClient } from '../@types/base'
import { fromDBSetting } from '../utils/transform'
import { ISettingRepository } from '../@types/repositories'

const debug = createLogger('config-repository')

export class SettingRepository implements ISettingRepository {
  public constructor(private readonly dbClient: DatabaseClient) { }

  public async getSetting(
    category: string,
    key: string,
    client: DatabaseClient = this.dbClient
  ): Promise<Setting | undefined> {
    debug('find config by key: %s and category %s', category, key)
    const [dbsetting] = await client<DBSetting>('configs')
      .where('key', key)
      .where('category', category)
      .select()

    if (!dbsetting) {
      return
    }

    return fromDBSetting(dbsetting)
  }

  public async getSettings(
    client: DatabaseClient = this.dbClient
  ): Promise<Setting[] | undefined> {
    debug('get all configs')
    const settings = await client<Setting>('configs')
      .select()

    if (!settings) {
      return
    }

    return settings
  }

  public async upsertSetting(
    config: Setting,
    client: DatabaseClient = this.dbClient,
  ): Promise<number> {
    debug('upsert: %o', config)

    const date = new Date()

    const row = applySpec<DBSetting>({
      key: prop('key'),
      value: prop('value'),
      category: prop('category'),
      updated_at: always(date),
      created_at: always(date),
    })(config)

    const query = client<DBSetting>('configs')
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
