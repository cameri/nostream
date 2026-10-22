import { cpus } from 'os'

import { AdminOpsConfiguredWorker, AdminOpsWorkerHeartbeat, AdminOpsWorkerRow } from '../@types/admin-ops'
import { Settings } from '../@types/settings'
import { ADMIN_OPS_HEARTBEAT_TTL_SECONDS, isAdminOpsHeartbeatStale } from './admin-ops-store'

const UNMONITORED_WORKER_TYPES = new Set(['worker', 'dvm-orchestrator'])

export const isAdminOpsWorkerMonitored = (type: string): boolean => !UNMONITORED_WORKER_TYPES.has(type)

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
