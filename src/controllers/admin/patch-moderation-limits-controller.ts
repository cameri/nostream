import { Request, Response } from 'express'

import { IController } from '../../@types/controllers'
import { INotificationOutboxRepository } from '../../@types/repositories'
import { adminModerationLimitsPatchSchema } from '../../schemas/admin-moderation-schema'
import {
  mergeAdminModerationLimitsPatch,
  readAdminModerationLimits,
  ValidationError,
} from '../../utils/admin-moderation'
import { saveModerationLimitsFromRequest } from '../../utils/admin-moderation-persist'
import { validateSchema } from '../../utils/validation'

export class PatchAdminModerationLimitsController implements IController {
  public constructor(private readonly notificationOutboxRepository: INotificationOutboxRepository) {}

  public async handleRequest(request: Request, response: Response): Promise<void> {
    const validation = validateSchema(adminModerationLimitsPatchSchema)(request.body)
    if (validation.error) {
      response.status(400).setHeader('content-type', 'application/json').send({ error: 'Invalid request' })
      return
    }

    const next = mergeAdminModerationLimitsPatch(readAdminModerationLimits(), validation.value)

    try {
      await saveModerationLimitsFromRequest(
        next,
        request,
        this.notificationOutboxRepository,
        'moderation.limits.updated',
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

    response.status(200).setHeader('content-type', 'application/json').send({ ok: true, limits: next })
  }
}
