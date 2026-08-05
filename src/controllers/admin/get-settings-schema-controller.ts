import { Request, Response } from 'express'

import { IController } from '../../@types/controllers'
import { guidedSettingCategories } from '../../utils/settings-guided-schema'

export class GetAdminSettingsSchemaController implements IController {
  public async handleRequest(_request: Request, response: Response): Promise<void> {
    const categories = guidedSettingCategories.map((category) => ({
      ...category,
      settings: category.settings.map(({ validate: _validate, ...setting }) => setting),
    }))

    response.status(200).setHeader('content-type', 'application/json').send({ categories })
  }
}
