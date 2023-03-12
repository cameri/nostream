import { createLogger } from '../factories/logger-factory'
import { DatabaseClient } from '../@types/base'
import { Setting } from '../@types/setting'
import { SettingRepository } from '../repositories/settings-repository'
import { Settings } from '../@types/settings'

const debug = createLogger('settings')

export class SettingsStatic {
  private static _instance: SettingsStatic
  private static dbClient: DatabaseClient
  static _settings: Settings | undefined
  static settingsRepository: SettingRepository | undefined

  constructor(dbClient: DatabaseClient) {
    SettingsStatic.dbClient = dbClient
    SettingsStatic.settingsRepository = new SettingRepository(dbClient)
    if (SettingsStatic._instance) {
      throw new Error('Use Singleton.instance instead of new.')
    }

    SettingsStatic._instance = this
  }

  public init() {
    debug('SettingsStatic.init()')
    return new Promise((resolve, reject) => {
      const settingsPromise = SettingsStatic.loadSettingsFromDb(SettingsStatic.constructSettingsJsonBlob)
      if (settingsPromise) {
        resolve('success')
      }
      reject('Failed to initialize settings')
    })
  }

  static get instance() {
    return SettingsStatic._instance ?? (SettingsStatic._instance = new SettingsStatic(this.dbClient))
  }

  private static loadSettingsFromDb(callback) {
    debug('SettingsStatic.loadSettingsFromDb()')
    const promise = SettingsStatic.settingsRepository.getSettings()

    return promise.then(rawSettingsFromDb => {
      const settingsJsonBlob = callback(rawSettingsFromDb)
      this._settings = settingsJsonBlob
    })
  }


  public static createSettings(): Settings {
    return this._settings
  }

  public static async updateSetting(config: Setting) {
    await SettingsStatic.settingsRepository.upsertSetting(config)

    this.updateSingletonSettings(config)
  }

  private static updateSingletonSettings(setting) {
    const updateSettings = this._settings
    updateSettings[setting.category][setting.key] = setting.value
  }

  private static constructSettingsJsonBlob(rawSettingsFromDb): any {
    const settings = {}
    rawSettingsFromDb.map(setting => {
      settings[setting.category][setting.key] = setting.value
    })

    return settings
  }
}
