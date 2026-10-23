import { Request, Response } from 'express'

import { IController } from '../../@types/controllers'
import { adminSettingsRestoreBodySchema } from '../../schemas/admin-settings-schema'
import { appendSettingsAuditLog, restoreSettingsBackup } from '../../utils/settings-config'
import { validateSchema } from '../../utils/validation'
import { recordAdminAuditFromRequest } from '../../utils/record-admin-audit'

export class PostAdminSettingsRestoreController implements IController {
  public async handleRequest(request: Request, response: Response): Promise<void> {
    const validation = validateSchema(adminSettingsRestoreBodySchema)(request.body)
    if (validation.error) {
      response.status(400).setHeader('content-type', 'application/json').send({ error: 'Invalid request' })
      return
    }

    try {
      await restoreSettingsBackup(validation.value.filename)
      appendSettingsAuditLog({
        action: 'settings.restored',
        filename: validation.value.filename,
        remoteAddress: request.ip,
      })
      await recordAdminAuditFromRequest('settings.restored', request, { filename: validation.value.filename })

      response.status(200).setHeader('content-type', 'application/json').send({ ok: true, filename: validation.value.filename })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Restore failed'
      response.status(400).setHeader('content-type', 'application/json').send({ error: message })
    }
  }
}
