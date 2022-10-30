import { AfterAll, BeforeAll } from '@cucumber/cucumber'

import { AppWorker } from '../../../src/app/worker'
import { DatabaseClient } from '../../../src/@types/base'
import { getDbClient } from '../../../src/database/client'
import { SettingsStatic } from '../../../src/utils/settings'
import { workerFactory } from '../../../src/factories/worker-factory'

let worker: AppWorker

let dbClient: DatabaseClient

BeforeAll({ timeout: 6000 }, async function () {
  dbClient = getDbClient()
  await dbClient.raw('SELECT 1=1')

  const limits = SettingsStatic.createSettings().limits
  limits.event.createdAt.maxPositiveDelta = 0

  worker = workerFactory()
  worker.run()
})

AfterAll(async function() {
  worker.close(async () => {
    await dbClient.destroy()
  })
})
