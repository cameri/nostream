import { join } from 'path'

import {
  getConfigBaseDir,
  getDefaultSettingsFilePath,
  getSettingsFilePath,
} from '../../utils/settings-config'
import { getLegacySettingsFilePath } from '../../utils/settings-paths'

export const getProjectRoot = (): string => process.cwd()

export const getProjectPath = (...parts: string[]): string => join(getProjectRoot(), ...parts)

export { getConfigBaseDir, getDefaultSettingsFilePath, getLegacySettingsFilePath, getSettingsFilePath }

export const getEnvFilePath = (): string => getProjectPath('.env')
