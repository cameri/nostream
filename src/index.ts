import cluster from 'cluster'

import { appFactory } from './factories/app-factory'
import { createLogger } from './factories/logger-factory'
import { dvmOrchestratorWorkerFactory } from './factories/dvm-orchestrator-worker-factory'
import { maintenanceWorkerFactory } from './factories/maintenance-worker-factory'
import { relayMonitorWorkerFactory } from './factories/relay-monitor-worker-factory'
import { staticMirroringWorkerFactory } from './factories/static-mirroring.worker-factory'
import { workerFactory } from './factories/worker-factory'
import { initializeMetricsTelemetry } from './telemetry/metrics'
import { bootstrapSettingsStore } from './utils/settings-store'

const logger = createLogger('index')

export const getRunner = () => {
  if (cluster.isPrimary) {
    return appFactory()
  } else {
    switch (process.env.WORKER_TYPE) {
      case 'worker':
        return workerFactory()
      case 'maintenance':
        return maintenanceWorkerFactory()
      case 'static-mirroring':
        return staticMirroringWorkerFactory()
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

  void bootstrapSettingsStore()
    .then(() => {
      getRunner().run()
    })
    .catch((error) => {
      logger.error('failed to bootstrap settings store:', error)
      process.exit(1)
    })
}
