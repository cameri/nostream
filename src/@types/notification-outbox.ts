export enum NotificationOutboxStatus {
  PENDING = 'pending',
  PROCESSING = 'processing',
  DELIVERED = 'delivered',
  DEAD = 'dead',
}

/** @deprecated Use OperatorNotificationEventType from operator-notifications.ts */
export enum NotificationOutboxEventType {
  OPERATOR_SETTINGS_UPDATED = 'settings.changed',
  OPERATOR_INVOICE_PAID = 'admission.invoice.paid',
}

export type NotificationOutboxPayload = Record<string, unknown>

export interface NotificationOutboxMessage {
  id: string
  eventType: NotificationOutboxEventType | string
  payload: NotificationOutboxPayload
  status: NotificationOutboxStatus
  attemptCount: number
  availableAt: Date
  lastError: string | null
  deliveredAt: Date | null
  createdAt: Date
  updatedAt: Date
}

export interface DBNotificationOutboxMessage {
  id: string
  event_type: string
  payload: NotificationOutboxPayload
  status: NotificationOutboxStatus
  attempt_count: number
  available_at: Date
  last_error: string | null
  delivered_at: Date | null
  created_at: Date
  updated_at: Date
}
