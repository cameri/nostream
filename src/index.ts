import cluster from 'cluster'
import dotenv from 'dotenv'
dotenv.config()

import { appFactory } from './factories/app-factory'
import { maintenanceWorkerFactory } from './factories/maintenance-worker-factory'
import { SettingsStatic } from './utils/settings'
import { staticMirroringWorkerFactory } from './factories/static-mirroring.worker-factory'
import { workerFactory } from './factories/worker-factory'

export const getRunner = (): any => {
  const settingsInstance = SettingsStatic.instance

  settingsInstance.init()
    .then(() => {
      if (cluster.isPrimary) {
        return appFactory().run()
      } else {
        switch (process.env.WORKER_TYPE) {
          case 'worker':
            return workerFactory().run()
          case 'maintenance':
            return maintenanceWorkerFactory().run()
          case 'static-mirroring':
            return staticMirroringWorkerFactory().run()
          default:
            throw new Error(`Unknown worker: ${process.env.WORKER_TYPE}`)
        }
      }
    })
    .catch(error => {
      console.log('whoooops---------', error)
      throw new Error('Failed to load settings', error)
    })
}

if (require.main === module) {
  getRunner()
}
