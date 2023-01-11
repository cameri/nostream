import fs from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { mergeDeepRight } from 'ramda'

import { createLogger } from '../factories/logger-factory'
import defaultSettingsJson from '../../resources/default-settings.json'
import { ISettings } from '../@types/settings'

const debug = createLogger('settings')

export class SettingsStatic {
  static _settings: ISettings

  public static getSettingsFilePath(filename = 'settings.json') {
    return join(
      process.env.NOSTR_CONFIG_DIR ?? join(homedir(), '.nostr'),
      filename
    )
  }

  public static loadSettings(path: string) {
    debug('loading settings from %s', path)
    return JSON.parse(
      fs.readFileSync(
        path,
        { encoding: 'utf-8' }
      )
    )
  }

  public static createSettings(): ISettings {
    if (SettingsStatic._settings) {
      return SettingsStatic._settings
    }
    debug('creating settings')
    const path = SettingsStatic.getSettingsFilePath()
    const defaults = defaultSettingsJson as ISettings
    try {

      if (fs.existsSync(path)) {
        SettingsStatic._settings = mergeDeepRight(
          defaults,
          SettingsStatic.loadSettings(path)
        )
      } else {
        SettingsStatic.saveSettings(path, defaults)
        SettingsStatic._settings = mergeDeepRight({}, defaults)
      }

      return SettingsStatic._settings
    } catch (error) {
      debug('error reading config file at %s: %o', path, error)

      return defaults
    }
  }

  public static saveSettings(path: string, settings: ISettings) {
    debug('saving settings to %s: %o', path, settings)
    return fs.writeFileSync(
      path,
      JSON.stringify(settings, null, 2),
      { encoding: 'utf-8' }
    )
  }
}
