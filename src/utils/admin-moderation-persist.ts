import { Request } from 'express'

import { OperatorNotificationEventType } from '../@types/operator-notifications'
import { INotificationOutboxRepository } from '../@types/repositories'
import { createLogger } from '../factories/logger-factory'
import { appendSettingsAuditLog } from './settings-config'
import { recordAdminAuditFromRequest } from './record-admin-audit'
import { AdminModerationLimits, persistAdminModerationLimits, ValidationError } from './admin-moderation'

const logger = createLogger('admin-moderation-persist')

const MODERATION_SETTINGS_PATHS = [
  'limits.event.pubkey.blacklist',
  'limits.event.pubkey.whitelist',
  'limits.event.kind.blacklist',
  'limits.event.kind.whitelist',
  'limits.event.whitelists.pubkeys',
  'limits.event.whitelists.ipAddresses',
] as const

export const saveModerationLimitsFromRequest = async (
  limits: AdminModerationLimits,
  request: Request,
  notificationOutboxRepository: INotificationOutboxRepository,
  auditAction: 'moderation.limits.updated' | 'moderation.action',
  auditDetail?: Record<string, unknown>,
): Promise<void> => {
  try {
    await persistAdminModerationLimits(limits)
  } catch (error) {
    if (error instanceof ValidationError) {
      throw error
    }
    throw error
  }

  const changes = MODERATION_SETTINGS_PATHS.map((path) => ({ path, reload: 'hot-reload' as const }))
  appendSettingsAuditLog({
    action: 'settings.updated',
    changes,
    remoteAddress: request.ip,
  })
  await recordAdminAuditFromRequest(auditAction, request, auditDetail)

  try {
    await notificationOutboxRepository.enqueue(OperatorNotificationEventType.SETTINGS_CHANGED, {
      changes,
      remoteAddress: request.ip,
    })
  } catch (error) {
    logger.error('Unable to enqueue moderation settings notification outbox event', error)
  }
}
