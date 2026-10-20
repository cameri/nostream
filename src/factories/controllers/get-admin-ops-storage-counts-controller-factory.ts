import { IController } from '../../@types/controllers'
import { getMasterDbClient, getReadReplicaDbClient } from '../../database/client'
import { GetAdminOpsStorageCountsController } from '../../controllers/admin/get-ops-storage-counts-controller'
import { createEventRepository } from '../event-repository-factory'

export const createGetAdminOpsStorageCountsController = (): IController => {
  const eventRepository = createEventRepository(getMasterDbClient(), getReadReplicaDbClient())
  return new GetAdminOpsStorageCountsController(eventRepository)
}
