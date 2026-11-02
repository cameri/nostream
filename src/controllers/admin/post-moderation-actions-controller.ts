import { Request, Response } from 'express'

import { IController } from '../../@types/controllers'
import { INotificationOutboxRepository } from '../../@types/repositories'
import { adminModerationActionSchema } from '../../schemas/admin-moderation-schema'
import {
  applyAdminModerationAction,
  readAdminModerationLimits,
  ValidationError,
} from '../../utils/admin-moderation'
import { saveModerationLimitsFromRequest } from '../../utils/admin-moderation-persist'
import { validateSchema } from '../../utils/validation'

export class PostAdminModerationActionsController implements IController {
  public constructor(private readonly notificationOutboxRepository: INotificationOutboxRepository) {}

  public async handleRequest(request: Request, response: Response): Promise<void> {
    const validation = validateSchema(adminModerationActionSchema)(request.body)
    if (validation.error) {
      response.status(400).setHeader('content-type', 'application/json').send({ error: 'Invalid request' })
      return
    }

    const { action, pubkey, ip } = validation.value

    try {
      applyAdminModerationAction(readAdminModerationLimits(), action, { pubkey, ip })
    } catch (error) {
      response
        .status(400)
        .setHeader('content-type', 'application/json')
        .send({ error: error instanceof Error ? error.message : 'Invalid action' })
      return
    }

    try {
      await saveModerationLimitsFromRequest(
        (current) => applyAdminModerationAction(current, action, { pubkey, ip }),
        request,
        this.notificationOutboxRepository,
        'moderation.action',
        {
          action,
          pubkey,
          ip,
        },
      )
    } catch (error) {
      if (error instanceof ValidationError) {
        response
          .status(400)
          .setHeader('content-type', 'application/json')
          .send({ error: error.message, issues: error.issues })
        return
      }

      if (error instanceof Error) {
        response.status(400).setHeader('content-type', 'application/json').send({ error: error.message })
        return
      }

      throw error
    }

    response
      .status(200)
      .setHeader('content-type', 'application/json')
      .send({ ok: true, limits: readAdminModerationLimits() })
  }
}
