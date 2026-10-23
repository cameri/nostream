export type AdminAuditAction =
  | 'admin.login'
  | 'admin.logout'
  | 'settings.updated'
  | 'settings.restored'
  | 'notifications.updated'
  | 'probe.manual_run'
  | 'nip05.reverify'

export interface AdminAuditEntry {
  id: string
  at: string
  action: AdminAuditAction
  remoteAddress?: string
  detail?: Record<string, unknown>
}

export const ADMIN_AUDIT_LOG_KEY = 'admin:audit:log'
export const MAX_ADMIN_AUDIT_ENTRIES = 2000
export const MAX_ADMIN_AUDIT_API_LIMIT = 500
