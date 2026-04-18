import { createLogger } from '../factories/logger-factory'

import { createDashboardService } from './app'
import { getDashboardServiceConfig } from './config'

const debug = createLogger('dashboard-service:index')

const run = async () => {
  const config = getDashboardServiceConfig()
  console.info('dashboard-service: bootstrapping with config %o', config)
  const service = createDashboardService(config)

  const shutdown = async () => {
    console.info('dashboard-service: received shutdown signal')
    debug('received shutdown signal')
    await service.stop()
    process.exit(0)
  }

  process
    .on('SIGINT', shutdown)
    .on('SIGTERM', shutdown)

  process.on('uncaughtException', (error) => {
    console.error('dashboard-service: uncaught exception', error)
  })

  process.on('unhandledRejection', (error) => {
    console.error('dashboard-service: unhandled rejection', error)
  })

  await service.start()
}

if (require.main === module) {
  run().catch((error) => {
    console.error('dashboard-service: unable to start', error)
    process.exit(1)
  })
}

export { run }
