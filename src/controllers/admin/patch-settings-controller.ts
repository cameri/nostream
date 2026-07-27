import { Request, Response } from 'express'

import { Settings } from '../../@types/settings'
import { IController } from '../../@types/controllers'
import { adminSettingsPatchBodySchema } from '../../schemas/admin-settings-schema'
import {
  getByPath,
  loadMergedSettings,
  loadUserSettings,
  saveSettings,
  setByPath,
  validatePathAgainstDefaults,
  validateSettings,
} from '../../utils/settings-config'
import {
  isWriteProtectedSettingsPath,
  redactSettingsValue,
} from '../../utils/settings-redaction'
import { validateSchema } from '../../utils/validation'

export class PatchAdminSettingsController implements IController {
  public async handleRequest(request: Request, response: Response): Promise<void> {
    const validation = validateSchema(adminSettingsPatchBodySchema)(request.body)
    if (validation.error) {
      response.status(400).setHeader('content-type', 'application/json').send({ error: 'Invalid request' })
      return
    }

    const { path, value } = validation.value

    if (isWriteProtectedSettingsPath(path)) {
      response
        .status(400)
        .setHeader('content-type', 'application/json')
        .send({
          error: 'Validation failed',
          issues: [{ path, message: 'Path is write-protected' }],
        })
      return
    }

    const pathIssues = validatePathAgainstDefaults(path)
    if (pathIssues.length > 0) {
      response
        .status(400)
        .setHeader('content-type', 'application/json')
        .send({ error: 'Validation failed', issues: pathIssues })
      return
    }

    const userSettings = loadUserSettings() as unknown as Record<string, unknown>
    const nextUserSettings = setByPath(userSettings, path, value)

    const merged = loadMergedSettings() as unknown as Record<string, unknown>
    const mergedNext = setByPath(merged, path, getByPath(nextUserSettings, path))
    const validationIssues = validateSettings(mergedNext as unknown as Settings)

    if (validationIssues.length > 0) {
      response
        .status(400)
        .setHeader('content-type', 'application/json')
        .send({ error: 'Validation failed', issues: validationIssues })
      return
    }

    saveSettings(nextUserSettings as unknown as Settings)

    const updatedValue = redactSettingsValue(path, getByPath(nextUserSettings, path))

    response.status(200).setHeader('content-type', 'application/json').send({
      ok: true,
      path,
      value: updatedValue,
    })
  }
}
