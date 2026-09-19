import { Settings } from '../@types/settings'
import {
  AdminNotificationsSettings,
  NotificationDeliveryStatus,
  OperatorNotificationEnvelope,
  OperatorNotificationEventType,
  OperatorNotificationTarget,
} from '../@types/operator-notifications'
import { NotificationOutboxPayload } from '../@types/notification-outbox'
import { INotificationDeliveryLogRepository } from '../@types/repositories'
import { INotificationDispatcher } from '../@types/services'
import { createLogger } from '../factories/logger-factory'
import { loadDefaults } from '../utils/settings-config'
import { deliverToTarget, maskTargetForLog } from './notification-channels'

const logger = createLogger('operator-notification-service')

export interface OperatorNotificationDispatchContext {
  outboxId?: string
  attemptNumber?: number
}

export class OperatorNotificationService implements INotificationDispatcher {
  public constructor(
    private readonly settings: () => Settings,
    private readonly deliveryLogRepository: INotificationDeliveryLogRepository,
  ) {}

  public async dispatch(
    eventType: string,
    payload: NotificationOutboxPayload,
    context: OperatorNotificationDispatchContext = {},
  ): Promise<void> {
    const config = this.getNotificationsConfig()
    if (!config.enabled) {
      return
    }

    if (!this.isEventEnabled(config, eventType)) {
      return
    }

    const targets = config.targets.filter((target) => target.enabled)
    if (!targets.length) {
      return
    }

    const envelope = this.buildEnvelope(eventType, payload)
    const attemptNumber = context.attemptNumber ?? 1
    const failures: string[] = []

    for (const target of targets) {
      try {
        await deliverToTarget(target, envelope)
        await this.deliveryLogRepository.append({
          outboxId: context.outboxId ?? null,
          eventType,
          targetId: target.id,
          targetType: target.type,
          status: NotificationDeliveryStatus.SUCCESS,
          attemptNumber,
          errorSnippet: null,
        })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        logger.error('delivery failed for %s: %s', maskTargetForLog(target), message)
        failures.push(`${target.id}: ${message}`)
        await this.deliveryLogRepository.append({
          outboxId: context.outboxId ?? null,
          eventType,
          targetId: target.id,
          targetType: target.type,
          status: NotificationDeliveryStatus.FAILED,
          attemptNumber,
          errorSnippet: message.slice(0, 2000),
        })
      }
    }

    if (failures.length) {
      throw new Error(failures.join('; '))
    }
  }

  /** Sends a one-off test message to a single configured target (admin API). */
  public async dispatchTestTarget(targetId: string): Promise<void> {
    const config = this.getNotificationsConfig()
    const target = config.targets.find((entry) => entry.id === targetId)
    if (!target) {
      throw new Error(`Unknown notification target: ${targetId}`)
    }

    const envelope = this.buildEnvelope(OperatorNotificationEventType.RELAY_RESTARTED, {
      test: true,
      message: 'Operator notification test delivery',
    })

    await deliverToTarget(target, envelope)
  }

  public getMaxAttempts(): number {
    return this.getNotificationsConfig().retry.maxAttempts
  }

  private getNotificationsConfig(): AdminNotificationsSettings {
    const defaults = loadDefaults().admin?.notifications
    const configured = this.settings().admin?.notifications

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

  private isEventEnabled(config: AdminNotificationsSettings, eventType: string): boolean {
    const toggles = config.events as Record<string, boolean | undefined>
    return toggles[eventType] !== false
  }

  private buildEnvelope(eventType: string, payload: NotificationOutboxPayload): OperatorNotificationEnvelope {
    return {
      event: eventType,
      relay: this.settings().info.relay_url,
      timestamp: new Date().toISOString(),
      data: payload,
    }
  }
}

export const listEnabledTargets = (targets: OperatorNotificationTarget[]): OperatorNotificationTarget[] => {
  return targets.filter((target) => target.enabled)
}
