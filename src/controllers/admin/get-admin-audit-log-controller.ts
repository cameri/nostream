import { Request, Response } from 'express'

import { MAX_ADMIN_AUDIT_API_LIMIT } from '../../@types/admin-audit'
import { IController } from '../../@types/controllers'
import { AdminAuditStore } from '../../utils/admin-audit-store'

export class GetAdminAuditLogController implements IController {
  public constructor(private readonly auditStore: AdminAuditStore) {}

  public async handleRequest(request: Request, response: Response): Promise<void> {
    const limitCandidate = Number(request.query.limit ?? 100)
    const limit = Number.isFinite(limitCandidate)
      ? Math.min(Math.max(Math.floor(limitCandidate), 1), MAX_ADMIN_AUDIT_API_LIMIT)
      : 100

    const entries = await this.auditStore.list(limit)
    response.status(200).setHeader('content-type', 'application/json').send({ entries })
  }
}
