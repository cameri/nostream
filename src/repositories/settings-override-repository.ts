import { DatabaseClient } from '../@types/base'
import { Settings } from '../@types/settings'
import { createLogger } from '../factories/logger-factory'
import { flattenSettingsToPaths, setByPath } from '../utils/settings-config'

const logger = createLogger('settings-override-repository')

export class SettingsOverrideRepository {
  public constructor(private readonly dbClient: DatabaseClient) {}

  public async loadOverrides(): Promise<Settings> {
    const rows = await this.dbClient('settings_overrides').select('path', 'value')

    let settings: Record<string, unknown> = {}
    for (const row of rows) {
      settings = setByPath(settings, row.path, row.value)
    }

    return settings as unknown as Settings
  }

  public async replaceOverrides(overrides: Settings): Promise<void> {
    const entries = flattenSettingsToPaths(overrides)

    await this.dbClient.transaction(async (transaction) => {
      await transaction('settings_overrides').delete()

      if (entries.length === 0) {
        return
      }

      const now = new Date()
      await transaction('settings_overrides').insert(
        entries.map((entry) => ({
          path: entry.path,
          value: entry.value,
          updated_at: now,
        })),
      )
    })

    logger('replaced %d settings override paths', entries.length)
  }
}
