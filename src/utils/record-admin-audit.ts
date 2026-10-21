import { Request } from 'express'

import { RedisAdapter } from '../adapters/redis-adapter'
import { AdminAuditAction } from '../@types/admin-audit'
import { getCacheClient, isCacheConfigured } from '../cache/client'
import { appendAdminAuditEntrySafely } from './admin-audit-store'

const getAdminAuditCache = (): RedisAdapter | undefined => {
  if (!isCacheConfigured()) {
    return undefined
  }

  return new RedisAdapter(getCacheClient())
}

export const recordAdminAuditFromRequest = async (
  action: AdminAuditAction,
  request: Request,
  detail?: Record<string, unknown>,
): Promise<void> => {
  await appendAdminAuditEntrySafely(getAdminAuditCache(), action, {
    remoteAddress: request.ip,
    ...(detail ? { detail } : {}),
  })
}

export const recordAdminAudit = async (
  action: AdminAuditAction,
  fields: { remoteAddress?: string; detail?: Record<string, unknown> } = {},
): Promise<void> => {
  await appendAdminAuditEntrySafely(getAdminAuditCache(), action, fields)
}
