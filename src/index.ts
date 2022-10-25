import cluster from 'cluster'

import { appFactory } from './factories/app-factory'
import { workerFactory } from './factories/worker-factory'

export const run = (isPrimary: boolean) => {
  return (isPrimary)
    ? appFactory
    : workerFactory
}

if (require.main === module) {
  run(cluster.isPrimary)()
}
