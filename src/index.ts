import cluster from 'cluster'
import dotenv from 'dotenv'
dotenv.config()

import { appFactory } from './factories/app-factory'
import { workerFactory } from './factories/worker-factory'


export const getRunner = (isPrimary: boolean) => {
  return (isPrimary)
    ? appFactory()
    : workerFactory()
}

if (require.main === module) {
  getRunner(cluster.isPrimary).run()
}
