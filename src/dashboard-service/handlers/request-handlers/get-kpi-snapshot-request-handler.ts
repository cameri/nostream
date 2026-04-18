import { withController } from '../../../handlers/request-handlers/with-controller-request-handler'

import { GetKPISnapshotController } from '../../controllers/get-kpi-snapshot-controller'
import { SnapshotService } from '../../services/snapshot-service'

export const createGetKPISnapshotRequestHandler = (snapshotService: SnapshotService) => {
  return withController(() => new GetKPISnapshotController(snapshotService))
}