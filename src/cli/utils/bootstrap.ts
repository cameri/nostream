import fs from 'fs'
import { homedir } from 'os'
import { join } from 'path'

import {
  getConfigBaseDir,
  getDefaultSettingsFilePath,
  getLegacySettingsFilePath,
  getProjectPath,
  getSettingsFilePath,
} from './paths'

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

  // settings.yaml takes precedence over the deprecated settings.json, so writing the defaults next to an existing
  // settings.json would shadow every override in it (an admission policy, payment settings, limits) without a word.
  // A deployment that still has only settings.json keeps working on it, and the admin console writes settings.yaml
  // itself on the first save.
  if (!fs.existsSync(settingsFile) && !fs.existsSync(getLegacySettingsFilePath())) {
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
