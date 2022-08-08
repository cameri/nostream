import { readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

import packageJson from '../package.json'

interface Info {
  relay_url?: string
  name?: string
  description?: string
  pubkey?: string
  contact?: string
}

interface Settings {
  info: Info
}

const getDefaultSettings = (): Settings => ({
  info: {
    relay_url: undefined,
    name: `Unnamed ${packageJson.name}`,
    description: packageJson.description,
    pubkey: undefined,
    contact: undefined,
  },
})

const createSettingsFromFile = (defaults: Settings) => {
  const contents = JSON.parse(
    readFileSync(
      join(
        process.env.NOSTR_CONFIG_DIR ?? join(homedir(), '.nostr'),
        'settings.json',
      ),
      { encoding: 'utf8' },
    ),
  )

  return {
    info: {
      ...defaults.info,
      ...contents.info,
    },
  }
}

const createSettings = (): Settings => {
  const defaultSettings = getDefaultSettings()

  try {
    return createSettingsFromFile(defaultSettings)
  } catch (err) {
    console.error('Unable to read config file. Reason: %s', err.message)

    return defaultSettings
  }
}

export const Settings = createSettings()
