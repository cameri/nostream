import { IController } from '../../@types/controllers'
import { getMasterDbClient } from '../../database/client'
import { PostAdminOpsNip05ReverifyController } from '../../controllers/admin/post-ops-nip05-reverify-controller'
import { Nip05VerificationRepository } from '../../repositories/nip05-verification-repository'

export const createPostAdminOpsNip05ReverifyController = (): IController => {
  return new PostAdminOpsNip05ReverifyController(new Nip05VerificationRepository(getMasterDbClient()))
}
