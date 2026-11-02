import { readFileSync } from 'fs'
import { join } from 'path'

import { Settings } from '../@types/settings'
import { RedisAdapter } from '../adapters/redis-adapter'
import { getCacheClient } from '../cache/client'
import { AdminOpsStore } from './admin-ops-store'
import { collectAdminHealthSnapshot } from './admin-health'
import { getRedactedAdminNotifications } from './admin-notifications-settings'
import { RelayProbeSnapshotStore } from './relay-probe-snapshot'
import { loadMergedSettings } from './settings-config'
import { redactSettingsSecrets } from './settings-redaction'

export interface AdminDiagnosticsExport {
  generatedAt: string
  version: string
  health: Awaited<ReturnType<typeof collectAdminHealthSnapshot>>
  settings: Settings
  notifications: ReturnType<typeof getRedactedAdminNotifications>
  networkHealth: {
    latest: Awaited<ReturnType<RelayProbeSnapshotStore['getLatest']>>
  }
  operations: {
    workers: Awaited<ReturnType<AdminOpsStore['listWorkerHeartbeats']>>
  }
}

const readPackageVersion = (): string => {
  try {
    const raw = readFileSync(join(process.cwd(), 'package.json'), 'utf-8')
    const parsed = JSON.parse(raw) as { version?: string }
    return parsed.version ?? 'unknown'
  } catch {
    return process.env.npm_package_version ?? 'unknown'
  }
}

export const buildAdminDiagnosticsExport = async (
  getSettings: () => Settings = loadMergedSettings,
): Promise<AdminDiagnosticsExport> => {
  const cache = new RedisAdapter(getCacheClient())
  const opsStore = new AdminOpsStore(cache)
  const snapshotStore = new RelayProbeSnapshotStore(cache)

  const [health, workers, latest] = await Promise.all([
    collectAdminHealthSnapshot(),
    opsStore.listWorkerHeartbeats(),
    snapshotStore.getLatest(),
  ])

  const settings = redactSettingsSecrets(getSettings()) as Settings

  return {
    generatedAt: new Date().toISOString(),
    version: readPackageVersion(),
    health,
    settings,
    notifications: getRedactedAdminNotifications(),
    networkHealth: { latest },
    operations: { workers },
  }
}
