import { Request, Response } from 'express'

import { IController } from '../../@types/controllers'
import { guidedSettingCategories } from '../../utils/settings-guided-schema'

export class GetAdminSettingsSchemaController implements IController {
  public async handleRequest(_request: Request, response: Response): Promise<void> {
    response.status(200).setHeader('content-type', 'application/json').send({ categories: guidedSettingCategories })
  }
}
