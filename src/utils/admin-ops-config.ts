import { cpus } from 'os'

import {
  AdminOpsConfiguredMirror,
  AdminOpsConfiguredWorker,
  AdminOpsMirrorHeartbeat,
  AdminOpsMirrorRow,
  AdminOpsWorkerHeartbeat,
  AdminOpsWorkerRow,
} from '../@types/admin-ops'
import { Settings } from '../@types/settings'
import { ADMIN_OPS_HEARTBEAT_TTL_SECONDS, isAdminOpsHeartbeatStale } from './admin-ops-store'

const UNMONITORED_WORKER_TYPES = new Set(['worker', 'dvm-orchestrator'])

export const isAdminOpsWorkerMonitored = (type: string): boolean => !UNMONITORED_WORKER_TYPES.has(type)

export const listConfiguredMirrors = (settings: Settings): AdminOpsConfiguredMirror[] => {
  const mirrors = settings.mirroring?.static
  if (!Array.isArray(mirrors) || !mirrors.length) {
    return []
  }

  return mirrors.map((mirror, index) => ({
    index: index.toString(),
    targetUrl: mirror.address,
    enabled: true,
  }))
}

export const listConfiguredWorkers = (settings: Settings): AdminOpsConfiguredWorker[] => {
  const workers: AdminOpsConfiguredWorker[] = []

  const workerCount = process.env.WORKER_COUNT
    ? Number(process.env.WORKER_COUNT)
    : settings.workers?.count || cpus().length

  for (let i = 0; i < workerCount; i++) {
    workers.push({
      type: 'worker',
      index: i.toString(),
      enabled: true,
      label: `Client worker ${i}`,
    })
  }

  workers.push({
    type: 'maintenance',
    enabled: true,
    label: 'Maintenance',
  })

  const mirrors = listConfiguredMirrors(settings)
  for (const mirror of mirrors) {
    workers.push({
      type: 'static-mirroring',
      index: mirror.index,
      enabled: mirror.enabled,
      label: `Static mirror ${mirror.index}`,
    })
  }

  if (settings.nip66?.enabled) {
    workers.push({
      type: 'relay-monitor',
      enabled: true,
      label: 'Relay monitor (NIP-66)',
    })
  }

  const dvmWorkers = settings.dvm?.workers
  if (Array.isArray(dvmWorkers) && dvmWorkers.length) {
    for (let i = 0; i < dvmWorkers.length; i++) {
      workers.push({
        type: 'dvm-orchestrator',
        index: i.toString(),
        enabled: true,
        label: `DVM orchestrator ${i}`,
      })
    }
  }

  return workers
}

const heartbeatKey = (type: string, index?: string) =>
  typeof index === 'string' && index.length > 0 ? `${type}:${index}` : type

export const mergeMirrorRows = (
  configured: AdminOpsConfiguredMirror[],
  heartbeats: AdminOpsMirrorHeartbeat[],
): AdminOpsMirrorRow[] => {
  const byIndex = new Map(heartbeats.map((heartbeat) => [heartbeat.index, heartbeat]))

  return configured.map((mirror) => {
    const heartbeat = byIndex.get(mirror.index)
    return {
      ...mirror,
      heartbeat,
      stale: !heartbeat || isAdminOpsHeartbeatStale(heartbeat.updatedAt, ADMIN_OPS_HEARTBEAT_TTL_SECONDS),
    }
  })
}

export const mergeWorkerRows = (
  configured: AdminOpsConfiguredWorker[],
  heartbeats: AdminOpsWorkerHeartbeat[],
): AdminOpsWorkerRow[] => {
  const byKey = new Map(heartbeats.map((heartbeat) => [heartbeatKey(heartbeat.type, heartbeat.index), heartbeat]))

  return configured.map((worker) => {
    const heartbeat = byKey.get(heartbeatKey(worker.type, worker.index))
    const monitored = isAdminOpsWorkerMonitored(worker.type)
    return {
      ...worker,
      heartbeat,
      monitored,
      stale:
        monitored && (!heartbeat || isAdminOpsHeartbeatStale(heartbeat.updatedAt, ADMIN_OPS_HEARTBEAT_TTL_SECONDS)),
    }
  })
}
