import { Request, Response } from 'express'

import { IController } from '../../@types/controllers'
import { loadMergedSettings } from '../../utils/settings-config'
import { redactSettingsSecrets } from '../../utils/settings-redaction'

export class GetAdminSettingsController implements IController {
  public async handleRequest(_request: Request, response: Response): Promise<void> {
    const settings = redactSettingsSecrets(loadMergedSettings())

    response.status(200).setHeader('content-type', 'application/json').send({ settings })
  }
}
