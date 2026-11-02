export enum OperatorNotificationEventType {
  ADMISSION_INVOICE_CREATED = 'admission.invoice.created',
  ADMISSION_INVOICE_PAID = 'admission.invoice.paid',
  ADMISSION_INVOICE_FAILED = 'admission.invoice.failed',
  SETTINGS_CHANGED = 'settings.changed',
  RELAY_RESTARTED = 'relay.restarted',
  PROBE_FAILED = 'probe.failed',
  PROBE_RECOVERED = 'probe.recovered',
  SSL_EXPIRING = 'ssl.expiring',
}

export type OperatorNotificationChannelType = 'http' | 'discord' | 'slack' | 'telegram'

export interface OperatorNotificationTarget {
  id: string
  type: OperatorNotificationChannelType
  enabled: boolean
  url?: string
  /** HMAC-SHA256 signing secret for HTTP webhook payloads (optional). */
  secret?: string
  botToken?: string
  chatId?: string
}

export interface OperatorNotificationEventToggles {
  'admission.invoice.created'?: boolean
  'admission.invoice.paid'?: boolean
  'admission.invoice.failed'?: boolean
  'settings.changed'?: boolean
  'relay.restarted'?: boolean
  'probe.failed'?: boolean
  'probe.recovered'?: boolean
  'ssl.expiring'?: boolean
}

export interface OperatorNotificationRetrySettings {
  maxAttempts: number
  baseDelayMs: number
}

export interface AdminNotificationsSettings {
  enabled: boolean
  targets: OperatorNotificationTarget[]
  events: OperatorNotificationEventToggles
  retry: OperatorNotificationRetrySettings
  deliveryLogRetentionDays?: number
}

export interface OperatorNotificationEnvelope {
  event: string
  relay: string
  timestamp: string
  data: Record<string, unknown>
}

export enum NotificationDeliveryStatus {
  SUCCESS = 'success',
  FAILED = 'failed',
}

export interface NotificationDeliveryLogEntry {
  id: string
  outboxId: string | null
  eventType: string
  targetId: string
  targetType: OperatorNotificationChannelType
  status: NotificationDeliveryStatus
  attemptNumber: number
  errorSnippet: string | null
  createdAt: Date
}

export interface DBNotificationDeliveryLogEntry {
  id: string
  outbox_id: string | null
  event_type: string
  target_id: string
  target_type: OperatorNotificationChannelType
  status: NotificationDeliveryStatus
  attempt_number: number
  error_snippet: string | null
  created_at: Date
}
