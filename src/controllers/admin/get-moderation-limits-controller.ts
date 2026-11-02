import { Request, Response } from 'express'

import { IController } from '../../@types/controllers'
import { readAdminModerationLimits } from '../../utils/admin-moderation'

export class GetAdminModerationLimitsController implements IController {
  public async handleRequest(_request: Request, response: Response): Promise<void> {
    response.status(200).setHeader('content-type', 'application/json').send({
      limits: readAdminModerationLimits(),
    })
  }
}
