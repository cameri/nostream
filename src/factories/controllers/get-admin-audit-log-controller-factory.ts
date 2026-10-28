import { RedisAdapter } from '../../adapters/redis-adapter'
import { IController } from '../../@types/controllers'
import { getCacheClient } from '../../cache/client'
import { GetAdminAuditLogController } from '../../controllers/admin/get-admin-audit-log-controller'
import { AdminAuditStore } from '../../utils/admin-audit-store'

export const createGetAdminAuditLogController = (): IController => {
  const auditStore = new AdminAuditStore(new RedisAdapter(getCacheClient()))
  return new GetAdminAuditLogController(auditStore)
}
