import { Request, Response } from 'express'
import { z } from 'zod'

import { IController } from '../../@types/controllers'
import { IOperatorNotificationService } from '../../@types/services'
import { validateSchema } from '../../utils/validation'

const bodySchema = z
  .object({
    targetId: z.string().min(1),
  })
  .strict()

export class PostAdminNotificationTestController implements IController {
  public constructor(private readonly operatorNotificationService: IOperatorNotificationService) {}

  public async handleRequest(request: Request, response: Response): Promise<void> {
    const validation = validateSchema(bodySchema)(request.body)
    if (validation.error) {
      response.status(400).setHeader('content-type', 'application/json').send({ error: 'Invalid request' })
      return
    }

    try {
      await this.operatorNotificationService.dispatchTestTarget(validation.value.targetId)
      response.status(200).setHeader('content-type', 'application/json').send({ ok: true })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Delivery failed'
      response.status(502).setHeader('content-type', 'application/json').send({ error: message })
    }
  }
}
