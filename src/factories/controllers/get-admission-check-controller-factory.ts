import { getMasterDbClient, getReadReplicaDbClient } from '../../database/client'
import { createSettings } from '../settings-factory'
import { EventRepository } from '../../repositories/event-repository'
import { GetSubmissionCheckController } from '../../controllers/admission/get-admission-check-controller'
import { rateLimiterFactory } from '../rate-limiter-factory'
import { UserRepository } from '../../repositories/user-repository'

export const createGetAdmissionCheckController = () => {
  const dbClient = getMasterDbClient()
  const readReplicaDbClient = getReadReplicaDbClient()
  const eventRepository = new EventRepository(dbClient, readReplicaDbClient)
  const userRepository = new UserRepository(dbClient, eventRepository)

  return new GetSubmissionCheckController(userRepository, createSettings, rateLimiterFactory)
}
