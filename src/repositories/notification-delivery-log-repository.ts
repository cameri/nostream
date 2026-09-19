import { DatabaseClient } from '../@types/base'
import {
  DBNotificationDeliveryLogEntry,
  NotificationDeliveryLogEntry,
  NotificationDeliveryStatus,
  OperatorNotificationChannelType,
} from '../@types/operator-notifications'
import { INotificationDeliveryLogRepository } from '../@types/repositories'
import { createLogger } from '../factories/logger-factory'

const logger = createLogger('notification-delivery-log-repository')

function fromDB(row: DBNotificationDeliveryLogEntry): NotificationDeliveryLogEntry {
  return {
    id: row.id,
    outboxId: row.outbox_id,
    eventType: row.event_type,
    targetId: row.target_id,
    targetType: row.target_type,
    status: row.status,
    attemptNumber: row.attempt_number,
    errorSnippet: row.error_snippet,
    createdAt: row.created_at,
  }
}

export class NotificationDeliveryLogRepository implements INotificationDeliveryLogRepository {
  public constructor(private readonly dbClient: DatabaseClient) {}

  public async append(
    entry: {
      outboxId: string | null
      eventType: string
      targetId: string
      targetType: OperatorNotificationChannelType
      status: NotificationDeliveryStatus
      attemptNumber: number
      errorSnippet: string | null
    },
    client: DatabaseClient = this.dbClient,
  ): Promise<void> {
    logger('append delivery log %s %s %s', entry.eventType, entry.targetId, entry.status)

    await client<DBNotificationDeliveryLogEntry>('notification_delivery_log').insert({
      outbox_id: entry.outboxId,
      event_type: entry.eventType,
      target_id: entry.targetId,
      target_type: entry.targetType,
      status: entry.status,
      attempt_number: entry.attemptNumber,
      error_snippet: entry.errorSnippet,
      created_at: new Date(),
    })
  }

  public async findRecent(limit = 50, client: DatabaseClient = this.dbClient): Promise<NotificationDeliveryLogEntry[]> {
    const rows = await client<DBNotificationDeliveryLogEntry>('notification_delivery_log')
      .orderBy('created_at', 'desc')
      .limit(limit)
      .select('*')

    return rows.map(fromDB)
  }

  public async deleteOlderThan(cutoff: Date, client: DatabaseClient = this.dbClient): Promise<number> {
    const result = await client<DBNotificationDeliveryLogEntry>('notification_delivery_log')
      .where('created_at', '<', cutoff)
      .delete()

    return typeof result === 'number' ? result : 0
  }
}
