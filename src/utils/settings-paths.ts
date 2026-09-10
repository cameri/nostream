import { join } from 'path'

export const getConfigBaseDir = (): string => process.env.NOSTR_CONFIG_DIR ?? join(process.cwd(), '.nostr')

export const getSettingsFilePath = (): string => join(getConfigBaseDir(), 'settings.yaml')

/** Deprecated pre-yaml settings file, still read as a fallback so existing deployments keep their overrides. */
export const getLegacySettingsFilePath = (): string => join(getConfigBaseDir(), 'settings.json')

export const getDefaultSettingsFilePath = (): string => join(process.cwd(), 'resources', 'default-settings.yaml')

export const getSettingsBackupDir = (): string => join(getConfigBaseDir(), 'backups')

export const getSettingsAuditLogPath = (): string => join(getConfigBaseDir(), 'settings-audit.jsonl')
