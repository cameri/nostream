import { Request, Response } from 'express'

import { IController } from '../../@types/controllers'
import { INip05VerificationRepository } from '../../@types/repositories'
import { Settings } from '../../@types/settings'
import { getNip05VerifyExpirationMs, toAdminNip05Row } from '../../utils/admin-ops-nip05'
import { loadMergedSettings } from '../../utils/settings-config'

const DEFAULT_LIMIT = 50
const MAX_LIMIT = 200

const parseBoolean = (value: unknown): boolean | undefined => {
  if (value === undefined || value === '') {
    return undefined
  }
  if (value === 'true' || value === true) {
    return true
  }
  if (value === 'false' || value === false) {
    return false
  }
  return undefined
}

export class GetAdminOpsNip05VerificationsController implements IController {
  public constructor(
    private readonly nip05VerificationRepository: INip05VerificationRepository,
    private readonly getSettings: () => Settings = loadMergedSettings,
  ) {}

  public async handleRequest(request: Request, response: Response): Promise<void> {
    const settings = this.getSettings()
    const verifyExpirationMs = getNip05VerifyExpirationMs(settings)

    const limitRaw = Number(request.query.limit ?? DEFAULT_LIMIT)
    const offsetRaw = Number(request.query.offset ?? 0)
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(1, Math.floor(limitRaw)), MAX_LIMIT) : DEFAULT_LIMIT
    const offset = Number.isFinite(offsetRaw) ? Math.max(0, Math.floor(offsetRaw)) : 0

    const domain = typeof request.query.domain === 'string' ? request.query.domain.trim() : undefined
    const verified = parseBoolean(request.query.verified)
    const stale = parseBoolean(request.query.stale)

    const minFailuresRaw = request.query.minFailures ?? request.query.min_failures
    const minFailures =
      minFailuresRaw === undefined || minFailuresRaw === ''
        ? undefined
        : Number(minFailuresRaw)

    if (minFailures !== undefined && (!Number.isInteger(minFailures) || minFailures < 0)) {
      response.status(400).setHeader('content-type', 'application/json').send({ error: 'minFailures must be a non-negative integer' })
      return
    }

    const { rows, total } = await this.nip05VerificationRepository.listForAdmin({
      domain,
      verified,
      stale,
      minFailures,
      verifyExpirationMs,
      limit,
      offset,
    })

    response.status(200).setHeader('content-type', 'application/json').send({
      verifications: rows.map((row) => toAdminNip05Row(row, verifyExpirationMs)),
      pagination: { limit, offset, total },
      verifyExpirationMs,
    })
  }
}
