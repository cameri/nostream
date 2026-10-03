import { Request, Response } from 'express'

import { Settings } from '../../@types/settings'
import { IController } from '../../@types/controllers'
import { adminSettingsPatchBodySchema } from '../../schemas/admin-settings-schema'
import {
  appendSettingsAuditLog,
  getByPath,
  loadMergedSettings,
  loadUserSettings,
  setByPath,
  validatePathAgainstDefaults,
  validateSettings,
} from '../../utils/settings-config'
import { saveUserSettingsOverrides } from '../../utils/settings-store'
import {
  isWriteProtectedSettingsPath,
  redactSettingsValue,
} from '../../utils/settings-redaction'
import { validateSchema } from '../../utils/validation'
import { INotificationOutboxRepository } from '../../@types/repositories'
import { OperatorNotificationEventType } from '../../@types/operator-notifications'
import { redactSettingsSecrets } from '../../utils/settings-redaction'
import { createLogger } from '../../factories/logger-factory'

const logger = createLogger('patch-admin-settings-controller')

export class PatchAdminSettingsController implements IController {
  public constructor(private readonly notificationOutboxRepository: INotificationOutboxRepository) {}

  public async handleRequest(request: Request, response: Response): Promise<void> {
    const validation = validateSchema(adminSettingsPatchBodySchema)(request.body)
    if (validation.error) {
      response.status(400).setHeader('content-type', 'application/json').send({ error: 'Invalid request' })
      return
    }

    const changes = 'changes' in validation.value ? validation.value.changes : [validation.value]
    const issues = changes.flatMap(({ path }) => {
      if (isWriteProtectedSettingsPath(path)) {
        return [{ path, message: 'Path is write-protected' }]
      }

      return validatePathAgainstDefaults(path)
    })

    if (issues.length > 0) {
      response.status(400).setHeader('content-type', 'application/json').send({ error: 'Validation failed', issues })
      return
    }

    const userSettings = loadUserSettings() as unknown as Record<string, unknown>
    const nextUserSettings = changes.reduce(
      (settings, change) => setByPath(settings, change.path, change.value),
      userSettings,
    )
    const merged = loadMergedSettings() as unknown as Record<string, unknown>
    const mergedNext = changes.reduce(
      (settings, change) => setByPath(settings, change.path, getByPath(nextUserSettings, change.path)),
      merged,
    )
    const validationIssues = validateSettings(mergedNext as unknown as Settings)

    if (validationIssues.length > 0) {
      response
        .status(400)
        .setHeader('content-type', 'application/json')
        .send({ error: 'Validation failed', issues: validationIssues })
      return
    }

    await saveUserSettingsOverrides(nextUserSettings as unknown as Settings)
    const updatedChanges = changes.map(({ path }) => ({
      path,
      value: redactSettingsValue(path, getByPath(nextUserSettings, path)),
      reload: getSettingsReloadBehavior(path),
    }))
    appendSettingsAuditLog({
      action: 'settings.updated',
      changes: updatedChanges.map(({ path, reload }) => ({ path, reload })),
      remoteAddress: request.ip,
    })

    try {
      await this.notificationOutboxRepository.enqueue(OperatorNotificationEventType.SETTINGS_CHANGED, {
        changes: redactSettingsSecrets(
          updatedChanges.map(({ path, value, reload }) => ({ path, value, reload })),
        ),
        remoteAddress: request.ip,
      })
    } catch (error) {
      logger.error('Unable to enqueue settings notification outbox event', error)
    }

    if (changes.length === 1 && !('changes' in validation.value)) {
      const [change] = updatedChanges
      response.status(200).setHeader('content-type', 'application/json').send({ ok: true, ...change })
      return
    }

    response.status(200).setHeader('content-type', 'application/json').send({ ok: true, changes: updatedChanges })
  }
}

const getSettingsReloadBehavior = (path: string): 'hot-reload' | 'restart-required' => {
  if (path.startsWith('workers.') || path.startsWith('payments') || path.startsWith('network.')) {
    return 'restart-required'
  }

  return 'hot-reload'
}
