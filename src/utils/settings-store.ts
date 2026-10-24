import fs from 'fs'

import cluster from 'cluster'

import { Settings } from '../@types/settings'
import { getMasterDbClient } from '../database/client'
import { createLogger } from '../factories/logger-factory'
import { SettingsOverrideRepository } from '../repositories/settings-override-repository'
import { SettingsStatic } from './settings'
import {
  backupUserSettingsOverrides,
  loadUserSettingsFromFiles,
  saveSettings,
} from './settings-config'
import { getSettingsDbImportMarkerPath } from './settings-paths'

const logger = createLogger('settings-store')

const SETTINGS_OVERRIDES_RELOAD_EVENT = 'settings-overrides-reload'

let dbOverridesCache: Settings = {} as Settings
let bootstrapComplete = false
let reloadListenerRegistered = false

export type SettingsBackend = 'file' | 'db'

export const getSettingsBackend = (): SettingsBackend => {
  return process.env.SETTINGS_BACKEND === 'db' ? 'db' : 'file'
}

export const getDbOverridesCache = (): Settings => structuredClone(dbOverridesCache)

const isEmptyOverrides = (settings: Settings): boolean => {
  return Object.keys(settings as object).length === 0
}

const markSettingsFileImportComplete = (): void => {
  fs.writeFileSync(getSettingsDbImportMarkerPath(), `${new Date().toISOString()}\n`, { encoding: 'utf-8', mode: 0o600 })
}

const hasCompletedSettingsFileImport = (): boolean => {
  return fs.existsSync(getSettingsDbImportMarkerPath())
}

export const reloadDbOverridesFromDatabase = async (): Promise<void> => {
  if (getSettingsBackend() !== 'db') {
    return
  }

  const repository = new SettingsOverrideRepository(getMasterDbClient())
  dbOverridesCache = await repository.loadOverrides()
  SettingsStatic.invalidateCache()
}

const registerSettingsOverridesReloadListener = (): void => {
  if (reloadListenerRegistered || getSettingsBackend() !== 'db') {
    return
  }

  reloadListenerRegistered = true
  process.on('message', (message: { eventName?: string }) => {
    if (message?.eventName !== SETTINGS_OVERRIDES_RELOAD_EVENT) {
      return
    }

    void reloadDbOverridesFromDatabase().catch((error) => {
      logger.error('failed to reload database settings overrides: %o', error)
    })
  })
}

const broadcastSettingsOverridesReload = (): void => {
  if (getSettingsBackend() !== 'db' || !cluster.isPrimary || !cluster.workers) {
    return
  }

  for (const worker of Object.values(cluster.workers)) {
    worker?.send({ eventName: SETTINGS_OVERRIDES_RELOAD_EVENT })
  }
}

export const bootstrapSettingsStore = async (): Promise<void> => {
  registerSettingsOverridesReloadListener()

  if (getSettingsBackend() !== 'db') {
    bootstrapComplete = true
    return
  }

  const repository = new SettingsOverrideRepository(getMasterDbClient())
  let overrides = await repository.loadOverrides()

  if (!hasCompletedSettingsFileImport() && isEmptyOverrides(overrides)) {
    const fileOverrides = loadUserSettingsFromFiles()
    if (!isEmptyOverrides(fileOverrides)) {
      logger.info('importing settings overrides from file into database')
      await repository.replaceOverrides(fileOverrides)
      overrides = fileOverrides
    }
    markSettingsFileImportComplete()
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
    const previous = await repository.loadOverrides()
    if (!isEmptyOverrides(previous)) {
      backupUserSettingsOverrides(previous)
    }

    await repository.replaceOverrides(settings)
    dbOverridesCache = structuredClone(settings)
    SettingsStatic.invalidateCache()
    broadcastSettingsOverridesReload()
    return
  }

  saveSettings(settings)
}
