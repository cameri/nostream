import { join } from 'path'

import {
  getConfigBaseDir,
  getDefaultSettingsFilePath,
  getSettingsFilePath,
} from '../../utils/settings-config'

export const getProjectRoot = (): string => process.cwd()

export const getProjectPath = (...parts: string[]): string => join(getProjectRoot(), ...parts)

export { getConfigBaseDir, getDefaultSettingsFilePath, getSettingsFilePath }

export const getEnvFilePath = (): string => getProjectPath('.env')
