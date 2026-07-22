import { Request, Response } from 'express'

import { IController } from '../../@types/controllers'
import { listSettingsBackups } from '../../utils/settings-config'

export class GetAdminSettingsBackupsController implements IController {
  public async handleRequest(_request: Request, response: Response): Promise<void> {
    response.status(200).setHeader('content-type', 'application/json').send({ backups: listSettingsBackups() })
  }
}
