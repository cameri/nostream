import fs from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { mergeDeepRight } from 'ramda'

import { createLogger } from '../factories/logger-factory'
import { ISettings } from '../@types/settings'
import packageJson from '../../package.json'

const debug = createLogger('settings')
export class SettingsStatic {
  static _settings: ISettings

  public static getSettingsFilePath(filename = 'settings.json') {
    return join(
      process.env.NOSTR_CONFIG_DIR ?? join(homedir(), '.nostr'),
      filename
    )
  }

  public static getDefaultSettings(): ISettings {
    return {
      info: {
        relay_url: 'wss://nostr-ts-relay.your-domain.com',
        name: `${packageJson.name}.your-domain.com`,
        description: packageJson.description,
        pubkey: 'replace-with-your-pubkey',
        contact: 'operator@your-domain.com',
      },
      workers: {
        count: 0,
      },
      limits: {
        event: {
          eventId: {
            minLeadingZeroBits: 0,
          },
          kind: {
            whitelist: [],
            blacklist: [],
          },
          pubkey: {
            minLeadingZeroBits: 0,
            whitelist: [],
            blacklist: [],
          },
          createdAt: {
            maxPositiveDelta: 900,
            maxNegativeDelta: 0, // disabled
          },
        },
        client: {
          subscription: {
            maxSubscriptions: 10,
            maxFilters: 10,
          },
        },
      },
    }
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
    debug('creating settings')
    if (SettingsStatic._settings) {
      return SettingsStatic._settings
    }
    const path = SettingsStatic.getSettingsFilePath()
    const defaults = SettingsStatic.getDefaultSettings()
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
