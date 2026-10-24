import { GetAdminModerationLimitsController } from '../../controllers/admin/get-moderation-limits-controller'
import { IController } from '../../@types/controllers'

export const createGetAdminModerationLimitsController = (): IController => new GetAdminModerationLimitsController()
