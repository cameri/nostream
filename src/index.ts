import cluster from 'cluster'

import { appFactory } from './factories/app-factory'
import { dvmOrchestratorWorkerFactory } from './factories/dvm-orchestrator-worker-factory'
import { maintenanceWorkerFactory } from './factories/maintenance-worker-factory'
import { peeringSyncWorkerFactory } from './factories/peering-sync-worker-factory'
import { relayMonitorWorkerFactory } from './factories/relay-monitor-worker-factory'
import { workerFactory } from './factories/worker-factory'
import { initializeMetricsTelemetry } from './telemetry/metrics'

export const getRunner = () => {
  if (cluster.isPrimary) {
    return appFactory()
  } else {
    switch (process.env.WORKER_TYPE) {
      case 'worker':
        return workerFactory()
      case 'maintenance':
        return maintenanceWorkerFactory()
      case 'peering-sync':
        return peeringSyncWorkerFactory()
      case 'relay-monitor':
        return relayMonitorWorkerFactory()
      case 'dvm-orchestrator':
        return dvmOrchestratorWorkerFactory()
      default:
        throw new Error(`Unknown worker: ${process.env.WORKER_TYPE}`)
    }
  }
}

if (require.main === module) {
  initializeMetricsTelemetry()

  getRunner().run()
}
