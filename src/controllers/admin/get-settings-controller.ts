import { Request, Response } from 'express'

import { IController } from '../../@types/controllers'
import { Settings } from '../../@types/settings'
import { loadDefaults, loadMergedSettings, filterSettingsAgainstDefaults } from '../../utils/settings-config'
import { redactSettingsSecrets } from '../../utils/settings-redaction'

export class GetAdminSettingsController implements IController {
  public async handleRequest(_request: Request, response: Response): Promise<void> {
    const merged = loadMergedSettings()
    const defaults = loadDefaults()
    const filtered = filterSettingsAgainstDefaults(merged, defaults) as Settings
    const settings = redactSettingsSecrets(filtered)

    response.status(200).setHeader('content-type', 'application/json').send({ settings })
  }
}
