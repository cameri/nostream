import { existsSync, readFileSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { mergeDeepRight } from 'ramda'

import { ISettings } from '../@types/settings'
import packageJson from '../../package.json'

const getSettingsFilePath = (filename = 'settings.json') => join(
  process.env.NOSTR_CONFIG_DIR ?? join(homedir(), '.nostr'),
  filename,
)

let _settings: ISettings

const getDefaultSettings = (): ISettings => ({
  info: {
    relay_url: undefined,
    name: `Unnamed ${packageJson.name}`,
    description: packageJson.description,
    pubkey: '',
    contact: '',
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
        maxPositiveDelta: 900, // +15 min
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
})

const loadSettings = (path: string) => {
  return JSON.parse(
    readFileSync(
      path,
      { encoding: 'utf-8' },
    ),
  )
}

const createSettings = (): ISettings => {
  const path = getSettingsFilePath()
  const defaults = getDefaultSettings()
  try {
    if (_settings) {
      return _settings
    }

    if (!existsSync(path)) {
      saveSettings(path, defaults)
    }

    _settings = mergeDeepRight(defaults, loadSettings(path))

    return _settings
  } catch (error) {
    console.error('Unable to read config file. Reason: %s', error.message)

    return defaults
  }
}

export const saveSettings = (path: string, settings: ISettings) => {
  return writeFileSync(
    path,
    JSON.stringify(settings, null, 2),
    { encoding: 'utf-8' }
  )
}
export const Settings = createSettings()
