import { Router } from 'express'

import { createGetKPISnapshotRequestHandler } from '../handlers/request-handlers/get-kpi-snapshot-request-handler'
import { SnapshotService } from '../services/snapshot-service'

export const createDashboardRouter = (snapshotService: SnapshotService): Router => {
  const router = Router()

  router.get('/snapshot', createGetKPISnapshotRequestHandler(snapshotService))

  return router
}
