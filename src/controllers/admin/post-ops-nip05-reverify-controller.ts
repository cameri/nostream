import { Request, Response } from 'express'

import { IController } from '../../@types/controllers'
import { INip05VerificationRepository } from '../../@types/repositories'
import { Settings } from '../../@types/settings'
import { getNip05VerifyExpirationMs, toAdminNip05Row } from '../../utils/admin-ops-nip05'
import { reverifyNip05Verification } from '../../utils/nip05-reverification'
import { loadMergedSettings } from '../../utils/settings-config'
import { pubkeySchema } from '../../schemas/base-schema'
import { recordAdminAuditFromRequest } from '../../utils/record-admin-audit'

export class PostAdminOpsNip05ReverifyController implements IController {
  public constructor(
    private readonly nip05VerificationRepository: INip05VerificationRepository,
    private readonly getSettings: () => Settings = loadMergedSettings,
  ) {}

  public async handleRequest(request: Request, response: Response): Promise<void> {
    const pubkeyResult = pubkeySchema.safeParse(request.params.pubkey)
    if (!pubkeyResult.success) {
      response.status(400).setHeader('content-type', 'application/json').send({ error: 'Invalid pubkey' })
      return
    }

    const settings = this.getSettings()
    if (!settings.nip05 || settings.nip05.mode === 'disabled') {
      response.status(409).setHeader('content-type', 'application/json').send({ error: 'NIP-05 verification is disabled' })
      return
    }

    const existing = await this.nip05VerificationRepository.findByPubkey(pubkeyResult.data)
    if (!existing) {
      response.status(404).setHeader('content-type', 'application/json').send({ error: 'Verification record not found' })
      return
    }

    try {
      const updated = await reverifyNip05Verification(existing, this.nip05VerificationRepository)
      await recordAdminAuditFromRequest('nip05.reverify', request, { pubkey: pubkeyResult.data })
      const verifyExpirationMs = getNip05VerifyExpirationMs(settings)
      response
        .status(200)
        .setHeader('content-type', 'application/json')
        .send({ verification: toAdminNip05Row(updated, verifyExpirationMs) })
    } catch {
      response.status(502).setHeader('content-type', 'application/json').send({ error: 'Re-verification failed' })
    }
  }
}
