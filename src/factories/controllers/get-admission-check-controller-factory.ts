import { getMasterDbClient, getReadReplicaDbClient } from '../../database/client'
import { createEventRepository } from '../event-repository-factory'
import { createSettings } from '../settings-factory'
import { GetSubmissionCheckController } from '../../controllers/admission/get-admission-check-controller'
import { rateLimiterFactory } from '../rate-limiter-factory'
import { UserRepository } from '../../repositories/user-repository'

export const createGetAdmissionCheckController = () => {
  const dbClient = getMasterDbClient()
  const readReplicaDbClient = getReadReplicaDbClient()
  const eventRepository = createEventRepository(dbClient, readReplicaDbClient)
  const userRepository = new UserRepository(dbClient, eventRepository)

  return new GetSubmissionCheckController(userRepository, createSettings, rateLimiterFactory)
}
