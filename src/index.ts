import cluster from 'cluster'
import dotenv from 'dotenv'
dotenv.config()

import { appFactory } from './factories/app-factory'
import { maintenanceWorkerFactory } from './factories/maintenance-worker-factory'
import { staticMirroringWorkerFactory } from './factories/static-mirroring.worker-factory'
import { workerFactory } from './factories/worker-factory'

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
      default:
        throw new Error(`Unknown worker: ${process.env.WORKER_TYPE}`)
    }
  }
}

if (require.main === module) {
  getRunner().run()
}
