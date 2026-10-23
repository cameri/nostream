import { GetAdminModerationStatsController } from '../../controllers/admin/get-moderation-stats-controller'
import { IController } from '../../@types/controllers'

export const createGetAdminModerationStatsController = (): IController => new GetAdminModerationStatsController()
