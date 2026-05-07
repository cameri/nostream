import { join } from 'path'

export const getProjectRoot = (): string => process.cwd()

export const getProjectPath = (...parts: string[]): string => join(getProjectRoot(), ...parts)

export const getConfigBaseDir = (): string => process.env.NOSTR_CONFIG_DIR ?? getProjectPath('.nostr')

export const getSettingsFilePath = (): string => join(getConfigBaseDir(), 'settings.yaml')

export const getDefaultSettingsFilePath = (): string => getProjectPath('resources', 'default-settings.yaml')

export const getEnvFilePath = (): string => getProjectPath('.env')
