import { Settings } from '../@types/settings'
import { getMasterDbClient } from '../database/client'
import { createLogger } from '../factories/logger-factory'
import { SettingsOverrideRepository } from '../repositories/settings-override-repository'
import { SettingsStatic } from './settings'
import { loadUserSettingsFromFiles, saveSettings } from './settings-config'

const logger = createLogger('settings-store')

let dbOverridesCache: Settings = {} as Settings
let bootstrapComplete = false

export type SettingsBackend = 'file' | 'db'

export const getSettingsBackend = (): SettingsBackend => {
  return process.env.SETTINGS_BACKEND === 'db' ? 'db' : 'file'
}

export const getDbOverridesCache = (): Settings => structuredClone(dbOverridesCache)

const isEmptyOverrides = (settings: Settings): boolean => {
  return Object.keys(settings as object).length === 0
}

export const bootstrapSettingsStore = async (): Promise<void> => {
  if (getSettingsBackend() !== 'db') {
    bootstrapComplete = true
    return
  }

  const repository = new SettingsOverrideRepository(getMasterDbClient())
  let overrides = await repository.loadOverrides()

  if (isEmptyOverrides(overrides)) {
    const fileOverrides = loadUserSettingsFromFiles()
    if (!isEmptyOverrides(fileOverrides)) {
      logger.info('importing settings overrides from file into database')
      await repository.replaceOverrides(fileOverrides)
      overrides = fileOverrides
    }
  }

  dbOverridesCache = overrides
  bootstrapComplete = true
  SettingsStatic.invalidateCache()
}

export const saveUserSettingsOverrides = async (settings: Settings): Promise<void> => {
  if (getSettingsBackend() === 'db') {
    if (!bootstrapComplete) {
      throw new Error('settings store has not been bootstrapped')
    }

    const repository = new SettingsOverrideRepository(getMasterDbClient())
    await repository.replaceOverrides(settings)
    dbOverridesCache = structuredClone(settings)
    SettingsStatic.invalidateCache()
    return
  }

  saveSettings(settings)
}
