import { createLogger } from '../factories/logger-factory'
import { DatabaseClient } from '../@types/base'
import { getMasterDbClient } from '../database/client'
import { Setting } from '../@types/setting'
import { SettingRepository } from '../repositories/settings-repository'
import { Settings } from '../@types/settings'

const debug = createLogger('settings')

export class SettingsStatic {
  private static _instance: SettingsStatic
  private static dbClient: DatabaseClient
  static _settings: any | undefined
  static settingsRepository: SettingRepository | undefined

  private constructor(dbClient: DatabaseClient) {
    SettingsStatic.dbClient = dbClient
    SettingsStatic.settingsRepository = new SettingRepository(dbClient)
    if (SettingsStatic._instance) {
      throw new Error('Use Singleton.instance instead of new.')
    }

    SettingsStatic._instance = this
  }

  public async init() {
    debug('SettingsStatic.init()')
    await SettingsStatic.loadSettingsFromDb()
      //const settingsPromise = await SettingsStatic.loadSettingsFromDb(SettingsStatic.constructSettingsJsonBlob)
      //if (settingsPromise) {
        // resolve('success')
      //}
      // reject('Failed to initialize settings')
  }

  static get instance() {
    return SettingsStatic._instance ?? (SettingsStatic._instance = new SettingsStatic(getMasterDbClient()))
  }

  private static async loadSettingsFromDb() {
    debug('SettingsStatic.loadSettingsFromDb()')
    const rawDbSettings = await SettingsStatic.settingsRepository.getSettings()
    const parsedSettings = SettingsStatic.constructSettingsJsonBlob(rawDbSettings)
    this._settings = parsedSettings
    console.log('rawDbSettings', rawDbSettings)
    console.log('parsedSettings', parsedSettings)

    // return promise.then(rawSettingsFromDb => {
    //   const settingsJsonBlob = callback(rawSettingsFromDb)
    //   this._settings = settingsJsonBlob
    // })
  }

  public static createSettings(): Settings {
    return this._settings
  }

  public static async updateSetting(config: Setting) {
    await SettingsStatic.settingsRepository.upsertSetting(config)

    this.updateSingletonSettings(config)
  }

  private static updateSingletonSettings(setting) {
    const updatedSettings = this._settings
    updatedSettings[setting.category][setting.key] = setting.value
    this._settings = updatedSettings
  }

  private static constructSettingsJsonBlob(rawSettingsFromDb): any {
    const settings = {}
    rawSettingsFromDb.forEach(setting => {
      if (!settings[setting.category]) {
        settings[setting.category] = {}
      }
      settings[setting.category][setting.key] = setting.value
    })

    return settings
  }
}
