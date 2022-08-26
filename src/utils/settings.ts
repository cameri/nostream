import { homedir } from 'os'
import { join } from 'path'
import { mergeDeepRight } from 'ramda'
import { readFileSync } from 'fs'

import { ISettings } from '../@types/settings'
import packageJson from '../../package.json'

let _settings: ISettings

const getDefaultSettings = (): ISettings => ({
  info: {
    relay_url: undefined,
    name: `Unnamed ${packageJson.name}`,
    description: packageJson.description,
    pubkey: undefined,
    contact: undefined,
  },
  limits: {
    event: {
      eventId: {
        minimumZeroBits: 0,
      },
      kind: {
        whitelist: [],
        blacklist: [],
      },
      pubkey: {
        whitelist: [],
        blacklist: [],
      },
    },
    client: {
      subscription: {
        maximumCount: 10,
        maximumFilters: 5,
      },
    },
  },
})

const createSettingsFromFile = (defaults: ISettings) => {
  const contents = JSON.parse(
    readFileSync(
      join(
        process.env.NOSTR_CONFIG_DIR ?? join(homedir(), '.nostr'),
        'settings.json',
      ),
      { encoding: 'utf8' },
    ),
  )

  return mergeDeepRight(defaults, contents)
}


const createSettings = (): ISettings => {
  try {
    if (_settings) {
      return _settings
    }
    _settings = createSettingsFromFile(getDefaultSettings())

    return _settings
  } catch (err) {
    console.error('Unable to read config file. Reason: %s', err.message)

    return getDefaultSettings()
  }
}

export const Settings = createSettings()
