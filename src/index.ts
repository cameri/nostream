import cluster from 'cluster'
import dotenv from 'dotenv'
dotenv.config()

import { appFactory } from './factories/app-factory'
import { getMasterDbClient } from './database/client'
import { maintenanceWorkerFactory } from './factories/maintenance-worker-factory'
import { SettingsStatic } from './utils/settings'
import { staticMirroringWorkerFactory } from './factories/static-mirroring.worker-factory'
import { workerFactory } from './factories/worker-factory'

export const getRunner = (): any => {
  const dbClient = getMasterDbClient()
  const initializeSettings = new SettingsStatic(dbClient).init()
  console.log('here1i')

  initializeSettings
    .then(() => {
      if (cluster.isPrimary) {
        appFactory().run()
      } else {
        switch (process.env.WORKER_TYPE) {
          case 'worker':
            workerFactory().run()
            return
          case 'maintenance':
            maintenanceWorkerFactory().run()
            return
          case 'static-mirroring':
            staticMirroringWorkerFactory().run()
            return
          default:
            throw new Error(`Unknown worker: ${process.env.WORKER_TYPE}`)
        }
      }
    })
    .catch(error => {
      throw new Error('Failed to load settings', error)
    })
}

if (require.main === module) {
  getRunner()
}
