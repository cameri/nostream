import { Request, Response } from 'express'
import { mergeDeepRight } from 'ramda'

import { IController } from '../../@types/controllers'
import { INotificationOutboxRepository } from '../../@types/repositories'
import { Settings } from '../../@types/settings'
import { OperatorNotificationEventType } from '../../@types/operator-notifications'
import { createLogger } from '../../factories/logger-factory'
import { adminNotificationsPatchBodySchema } from '../../schemas/admin-notifications-schema'
import {
  getMergedAdminNotifications,
  getRedactedAdminNotifications,
  mergeAdminNotificationsPatch,
} from '../../utils/admin-notifications-settings'
import {
  appendSettingsAuditLog,
  loadDefaults,
  loadMergedSettings,
  loadUserSettings,
  saveSettings,
  validateSettings,
  withSettingsWriteLock,
} from '../../utils/settings-config'
import { validateSchema } from '../../utils/validation'
import { recordAdminAuditFromRequest } from '../../utils/record-admin-audit'

const logger = createLogger('patch-admin-notifications-controller')

export class PatchAdminNotificationsController implements IController {
  public constructor(private readonly notificationOutboxRepository: INotificationOutboxRepository) {}

  public async handleRequest(request: Request, response: Response): Promise<void> {
    const validation = validateSchema(adminNotificationsPatchBodySchema)(request.body)
    if (validation.error) {
      response.status(400).setHeader('content-type', 'application/json').send({ error: 'Invalid request' })
      return
    }

    // Read and write under the same settings-file lock the moderation writer
    // uses, so a notification save cannot clobber a ban written meanwhile.
    const outcome = await withSettingsWriteLock<
      | { ok: true; redacted: ReturnType<typeof getRedactedAdminNotifications> }
      | { ok: false; issues: Array<{ path: string; message: string }> }
    >(() => {
      const merged = loadMergedSettings()
      const current = getMergedAdminNotifications(merged)
      const nextNotifications = mergeAdminNotificationsPatch(current, validation.value)

      const userSettings = loadUserSettings() as Settings
      const nextUserSettings = mergeDeepRight(userSettings, {
        admin: {
          ...userSettings.admin,
          notifications: nextNotifications,
        },
      }) as Settings

      const mergedNext = mergeDeepRight(loadDefaults(), nextUserSettings) as Settings

      const issues = validateSettings(mergedNext)
      if (issues.length > 0) {
        return { ok: false as const, issues }
      }

      saveSettings(nextUserSettings)

      return { ok: true as const, redacted: getRedactedAdminNotifications() }
    })

    if ('issues' in outcome) {
      response
        .status(400)
        .setHeader('content-type', 'application/json')
        .send({ error: 'Validation failed', issues: outcome.issues })
      return
    }

    appendSettingsAuditLog({
      action: 'settings.updated',
      changes: [{ path: 'admin.notifications', reload: 'hot-reload' }],
      remoteAddress: request.ip,
    })
    await recordAdminAuditFromRequest('notifications.updated', request)

    try {
      await this.notificationOutboxRepository.enqueue(OperatorNotificationEventType.SETTINGS_CHANGED, {
        changes: [{ path: 'admin.notifications', reload: 'hot-reload' }],
        remoteAddress: request.ip,
      })
    } catch (error) {
      logger.error('Unable to enqueue notifications settings outbox event', error)
    }

    response.status(200).setHeader('content-type', 'application/json').send({
      ok: true,
      notifications: outcome.redacted,
    })
  }
}
