import fs from 'fs'
import { homedir } from 'os'
import { join } from 'path'

import { getConfigBaseDir, getDefaultSettingsFilePath, getProjectPath, getSettingsFilePath } from './paths'

export const ensureNotRoot = (): void => {
  if (typeof process.geteuid === 'function' && process.geteuid() === 0) {
    throw new Error('Nostream should not be run as root.')
  }
}

export const ensureConfigBootstrap = (): void => {
  const configDir = getConfigBaseDir()
  const settingsFile = getSettingsFilePath()
  const defaultsFile = getDefaultSettingsFilePath()

  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true })
  }

  if (!fs.existsSync(settingsFile)) {
    fs.copyFileSync(defaultsFile, settingsFile)
  }
}

export const ensureTorDataDir = (): void => {
  fs.mkdirSync(getProjectPath('.nostr', 'tor', 'data'), { recursive: true })
}

export const ensureI2PDataDir = (): void => {
  fs.mkdirSync(getProjectPath('.nostr', 'i2p', 'data'), { recursive: true })
}

export const getTorHostnamePath = (): string => getProjectPath('.nostr', 'tor', 'data', 'nostream', 'hostname')

export const getOnionKeyPath = (): string =>
  join(process.env.NOSTR_CONFIG_DIR ?? join(homedir(), '.nostr'), 'v3_onion_private_key')
