import { randomUUID } from 'crypto'

import { DatabaseClient } from '../@types/base'
import {
  DBNotificationOutboxMessage,
  NotificationOutboxMessage,
  NotificationOutboxPayload,
  NotificationOutboxStatus,
} from '../@types/notification-outbox'
import { INotificationOutboxRepository } from '../@types/repositories'
import { createLogger } from '../factories/logger-factory'

const logger = createLogger('notification-outbox-repository')

/** Reclaim PROCESSING rows when a worker dies after claim. */
export const NOTIFICATION_OUTBOX_PROCESSING_LEASE_MS = 5 * 60 * 1000

function fromDB(row: DBNotificationOutboxMessage): NotificationOutboxMessage {
  return {
    id: row.id,
    eventType: row.event_type,
    payload: row.payload,
    status: row.status,
    attemptCount: row.attempt_count,
    availableAt: row.available_at,
    lastError: row.last_error,
    deliveredAt: row.delivered_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export class NotificationOutboxRepository implements INotificationOutboxRepository {
  public constructor(private readonly dbClient: DatabaseClient) {}

  public async enqueue(
    eventType: string,
    payload: NotificationOutboxPayload,
    client: DatabaseClient = this.dbClient,
  ): Promise<NotificationOutboxMessage> {
    logger('enqueue notification outbox event %s', eventType)

    const now = new Date()
    const row: DBNotificationOutboxMessage = {
      id: randomUUID(),
      event_type: eventType,
      payload,
      status: NotificationOutboxStatus.PENDING,
      attempt_count: 0,
      available_at: now,
      last_error: null,
      delivered_at: null,
      created_at: now,
      updated_at: now,
    }

    await client<DBNotificationOutboxMessage>('notification_outbox').insert(row)

    return fromDB(row)
  }

  public async claimBatch(
    limit: number,
    client: DatabaseClient = this.dbClient,
  ): Promise<NotificationOutboxMessage[]> {
    logger('claim notification outbox batch (limit %d)', limit)

    return client.transaction(async (trx) => {
      const now = new Date()
      const staleBefore = new Date(now.getTime() - NOTIFICATION_OUTBOX_PROCESSING_LEASE_MS)

      const rows = await trx<DBNotificationOutboxMessage>('notification_outbox')
        .where((builder) => {
          builder
            .where((pending) => {
              pending
                .where('status', NotificationOutboxStatus.PENDING)
                .where('available_at', '<=', trx.fn.now())
            })
            .orWhere((processing) => {
              processing
                .where('status', NotificationOutboxStatus.PROCESSING)
                .where('updated_at', '<', staleBefore)
            })
        })
        .orderBy('created_at', 'asc')
        .limit(limit)
        .forUpdate()
        .skipLocked()
        .select('*')

      if (!rows.length) {
        return []
      }

      const ids = rows.map((row) => row.id)

      await trx<DBNotificationOutboxMessage>('notification_outbox').whereIn('id', ids).update({
        status: NotificationOutboxStatus.PROCESSING,
        updated_at: now,
      })

      return rows.map((row) =>
        fromDB({
          ...row,
          status: NotificationOutboxStatus.PROCESSING,
          updated_at: now,
        }),
      )
    })
  }

  public async markDelivered(id: string, client: DatabaseClient = this.dbClient): Promise<void> {
    logger('mark notification outbox delivered %s', id)

    const now = new Date()
    await client<DBNotificationOutboxMessage>('notification_outbox').where('id', id).update({
      status: NotificationOutboxStatus.DELIVERED,
      delivered_at: now,
      last_error: null,
      updated_at: now,
    })
  }

  public async markFailed(
    id: string,
    error: string,
    attemptCount: number,
    maxAttempts: number,
    baseDelayMs: number,
    client: DatabaseClient = this.dbClient,
  ): Promise<void> {
    logger('mark notification outbox failed %s (attempt %d)', id, attemptCount)

    const now = new Date()
    const isDead = attemptCount >= maxAttempts
    const delayBase = Math.max(0, baseDelayMs)
    const backoffMs = Math.min(60_000, delayBase * 2 ** Math.max(0, attemptCount - 1))
    const availableAt = new Date(now.getTime() + backoffMs)

    await client<DBNotificationOutboxMessage>('notification_outbox')
      .where('id', id)
      .update({
        status: isDead ? NotificationOutboxStatus.DEAD : NotificationOutboxStatus.PENDING,
        attempt_count: attemptCount,
        available_at: isDead ? now : availableAt,
        last_error: error.slice(0, 2000),
        updated_at: now,
      })
  }

  public async deleteTerminalOlderThan(cutoff: Date, client: DatabaseClient = this.dbClient): Promise<number> {
    logger('delete terminal notification outbox rows older than %s', cutoff.toISOString())

    const result = await client<DBNotificationOutboxMessage>('notification_outbox')
      .whereIn('status', [NotificationOutboxStatus.DELIVERED, NotificationOutboxStatus.DEAD])
      .where('updated_at', '<', cutoff)
      .delete()

    return typeof result === 'number' ? result : 0
  }
}
