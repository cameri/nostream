import { Request, Response } from 'express'

import { IController } from '../../@types/controllers'
import { loadMergedSettings, validateSettings } from '../../utils/settings-config'

export class PostAdminSettingsValidateController implements IController {
  public async handleRequest(_request: Request, response: Response): Promise<void> {
    const issues = validateSettings(loadMergedSettings())

    if (issues.length === 0) {
      response.status(200).setHeader('content-type', 'application/json').send({ valid: true, issues: [] })
      return
    }

    response.status(200).setHeader('content-type', 'application/json').send({ valid: false, issues })
  }
}
