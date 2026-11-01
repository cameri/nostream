import fs from 'fs'

import cluster, { Worker } from 'cluster'

import { Settings } from '../@types/settings'
import { destroyMasterDbClient, getMasterDbClient } from '../database/client'
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

export const SETTINGS_OVERRIDES_RELOAD_EVENT = 'settings-overrides-reload'
export const SETTINGS_OVERRIDES_CLUSTER_SYNC_EVENT = 'settings-overrides-cluster-sync'

let dbOverridesCache: Settings = {} as Settings
let bootstrapComplete = false
let reloadListenerRegistered = false
let writeChain: Promise<void> = Promise.resolve()

export type SettingsBackend = 'file' | 'db'

export type SettingsOverridesClusterSyncMessage = {
  eventName: typeof SETTINGS_OVERRIDES_CLUSTER_SYNC_EVENT
}

export const isSettingsOverridesClusterSyncMessage = (
  message: unknown,
): message is SettingsOverridesClusterSyncMessage =>
  typeof message === 'object' &&
  message !== null &&
  (message as SettingsOverridesClusterSyncMessage).eventName === SETTINGS_OVERRIDES_CLUSTER_SYNC_EVENT

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
  if (getSettingsBackend() !== 'db') {
    return
  }

  if (cluster.isWorker && typeof process.send === 'function') {
    process.send({ eventName: SETTINGS_OVERRIDES_CLUSTER_SYNC_EVENT })
    return
  }

  if (cluster.isPrimary && cluster.workers) {
    for (const worker of Object.values(cluster.workers)) {
      worker?.send({ eventName: SETTINGS_OVERRIDES_RELOAD_EVENT })
    }
  }
}

export const handleSettingsOverridesClusterSyncFromWorker = async (source: Worker): Promise<void> => {
  if (getSettingsBackend() !== 'db' || !cluster.isPrimary) {
    return
  }

  await reloadDbOverridesFromDatabase()

  for (const worker of Object.values(cluster.workers ?? {})) {
    if (worker?.id === source.id) {
      continue
    }

    worker?.send({ eventName: SETTINGS_OVERRIDES_RELOAD_EVENT })
  }
}

const withSettingsOverridesWriteLock = async <T>(operation: () => Promise<T>): Promise<T> => {
  let release: () => void = () => undefined
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })

  const previous = writeChain
  writeChain = previous.then(() => gate)
  await previous

  try {
    return await operation()
  } finally {
    release()
  }
}

const commitUserSettingsOverrides = async (settings: Settings): Promise<void> => {
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

export const updateUserSettingsOverrides = async (
  updater: (current: Settings) => Settings | Promise<Settings>,
): Promise<void> => {
  await withSettingsOverridesWriteLock(async () => {
    if (getSettingsBackend() === 'db') {
      if (!bootstrapComplete) {
        throw new Error('settings store has not been bootstrapped')
      }

      await reloadDbOverridesFromDatabase()
    }

    const current =
      getSettingsBackend() === 'db'
        ? structuredClone(dbOverridesCache)
        : (loadUserSettingsFromFiles() as Settings)
    const next = await updater(current)
    await commitUserSettingsOverrides(next)
  })
}

export const saveUserSettingsOverrides = async (settings: Settings): Promise<void> => {
  await updateUserSettingsOverrides(() => settings)
}

export const shutdownSettingsStore = async (): Promise<void> => {
  if (getSettingsBackend() === 'db') {
    await destroyMasterDbClient()
  }

  bootstrapComplete = false
  dbOverridesCache = {} as Settings
  writeChain = Promise.resolve()
}
