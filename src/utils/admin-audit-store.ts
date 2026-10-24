import { randomUUID } from 'crypto'

import { ICacheAdapter } from '../@types/adapters'
import {
  ADMIN_AUDIT_LOG_KEY,
  AdminAuditAction,
  AdminAuditEntry,
  MAX_ADMIN_AUDIT_API_LIMIT,
  MAX_ADMIN_AUDIT_ENTRIES,
} from '../@types/admin-audit'
import { createLogger } from '../factories/logger-factory'

const logger = createLogger('admin-audit-store')

export class AdminAuditStore {
  public constructor(private readonly cache: ICacheAdapter) {}

  public async append(
    action: AdminAuditAction,
    fields: Omit<AdminAuditEntry, 'id' | 'at' | 'action'> = {},
  ): Promise<AdminAuditEntry> {
    const entry: AdminAuditEntry = {
      id: randomUUID(),
      at: new Date().toISOString(),
      action,
      ...fields,
    }

    const score = Date.parse(entry.at)
    if (!Number.isFinite(score)) {
      throw new Error('Invalid audit timestamp')
    }

    await this.cache.addToSortedSet(ADMIN_AUDIT_LOG_KEY, { [JSON.stringify(entry)]: String(score) })
    await this.trim()
    return entry
  }

  public async list(limit: number): Promise<AdminAuditEntry[]> {
    await this.trim()
    const clamped = Math.min(Math.max(Math.floor(limit), 1), MAX_ADMIN_AUDIT_API_LIMIT)
    const raw = await this.cache.getRangeFromSortedSet(ADMIN_AUDIT_LOG_KEY, -clamped, -1)

    return raw
      .map((payload) => JSON.parse(payload) as AdminAuditEntry)
      .reverse()
  }

  private async trim(): Promise<void> {
    await this.cache.removeRangeByRankFromSortedSet(ADMIN_AUDIT_LOG_KEY, 0, -(MAX_ADMIN_AUDIT_ENTRIES + 1))
  }
}

export const appendAdminAuditEntrySafely = async (
  cache: ICacheAdapter | undefined,
  action: AdminAuditAction,
  fields: Omit<AdminAuditEntry, 'id' | 'at' | 'action'> = {},
): Promise<void> => {
  if (!cache) {
    return
  }

  try {
    await new AdminAuditStore(cache).append(action, fields)
  } catch (error) {
    logger.warn('failed to append admin audit entry %s: %o', action, error)
  }
}
