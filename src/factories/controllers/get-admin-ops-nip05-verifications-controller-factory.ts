import { IController } from '../../@types/controllers'
import { getMasterDbClient } from '../../database/client'
import { GetAdminOpsNip05VerificationsController } from '../../controllers/admin/get-ops-nip05-verifications-controller'
import { Nip05VerificationRepository } from '../../repositories/nip05-verification-repository'

export const createGetAdminOpsNip05VerificationsController = (): IController => {
  return new GetAdminOpsNip05VerificationsController(new Nip05VerificationRepository(getMasterDbClient()))
}
