import cluster from 'cluster'

import { appFactory } from './factories/app-factory'
import { dvmOrchestratorWorkerFactory } from './factories/dvm-orchestrator-worker-factory'
import { maintenanceWorkerFactory } from './factories/maintenance-worker-factory'
import { staticMirroringWorkerFactory } from './factories/static-mirroring.worker-factory'
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
      case 'static-mirroring':
        return staticMirroringWorkerFactory()
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
