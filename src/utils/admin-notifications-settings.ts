import { AdminNotificationsSettings, OperatorNotificationTarget } from '../@types/operator-notifications'
import { Settings } from '../@types/settings'
import { loadDefaults, loadMergedSettings } from './settings-config'
import { redactSettingsSecrets } from './settings-redaction'

const REDACTED_SECRET = '***'

export const getMergedAdminNotifications = (settings: Settings = loadMergedSettings()): AdminNotificationsSettings => {
  const defaults = loadDefaults().admin?.notifications
  const configured = settings.admin?.notifications

  return {
    enabled: configured?.enabled ?? defaults?.enabled ?? false,
    targets: configured?.targets ?? defaults?.targets ?? [],
    events: { ...defaults?.events, ...configured?.events },
    retry: {
      maxAttempts: configured?.retry?.maxAttempts ?? defaults?.retry?.maxAttempts ?? 5,
      baseDelayMs: configured?.retry?.baseDelayMs ?? defaults?.retry?.baseDelayMs ?? 1000,
    },
    deliveryLogRetentionDays:
      configured?.deliveryLogRetentionDays ?? defaults?.deliveryLogRetentionDays ?? 30,
  }
}

export const getRedactedAdminNotifications = (): AdminNotificationsSettings => {
  const merged = loadMergedSettings()
  const notifications = getMergedAdminNotifications(merged)
  const redacted = redactSettingsSecrets({ admin: { notifications } }) as Settings

  return getMergedAdminNotifications(redacted)
}

const isRedactedSecret = (value: unknown): boolean => value === REDACTED_SECRET

const mergeTargetSecrets = (
  incoming: OperatorNotificationTarget,
  existing: OperatorNotificationTarget | undefined,
): OperatorNotificationTarget => {
  const merged: OperatorNotificationTarget = { ...incoming }

  if (existing) {
    if (isRedactedSecret(incoming.url) || (incoming.url === undefined && existing.url)) {
      merged.url = existing.url
    }
    if (isRedactedSecret(incoming.botToken) || (incoming.botToken === undefined && existing.botToken)) {
      merged.botToken = existing.botToken
    }
  }

  return merged
}

export const mergeAdminNotificationsPatch = (
  current: AdminNotificationsSettings,
  patch: Partial<AdminNotificationsSettings>,
): AdminNotificationsSettings => {
  const next: AdminNotificationsSettings = {
    ...current,
    ...patch,
    events: patch.events ? { ...current.events, ...patch.events } : current.events,
    retry: patch.retry ? { ...current.retry, ...patch.retry } : current.retry,
  }

  if (patch.targets) {
    const existingById = new Map(current.targets.map((target) => [target.id, target]))
    next.targets = patch.targets.map((target) => mergeTargetSecrets(target, existingById.get(target.id)))
  }

  return next
}
