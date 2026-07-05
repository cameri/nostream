import { Request, Response } from 'express'

import { IController } from '../../@types/controllers'
import { collectAdminHealthSnapshot } from '../../utils/admin-health'

export class GetAdminHealthController implements IController {
  public async handleRequest(_request: Request, response: Response): Promise<void> {
    const health = await collectAdminHealthSnapshot()
    response.status(200).setHeader('content-type', 'application/json').send(health)
  }
}
