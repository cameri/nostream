import { Request, Response } from 'express'

import { IController } from '../../@types/controllers'
import { IPeeringBuyerService } from '../../@types/services'
import { serializePeeringInvoice } from './get-admin-peering-controller'

export class PostAdminPeeringInvoiceDecisionController implements IController {
  public constructor(private readonly peeringBuyerService: IPeeringBuyerService) {}

  public async handleRequest(request: Request, response: Response): Promise<void> {
    const paymentHash = typeof request.body?.paymentHash === 'string' ? request.body.paymentHash.trim() : ''
    const action = request.body?.action

    if (!paymentHash || (action !== 'approve' && action !== 'reject')) {
      response.status(400).setHeader('content-type', 'application/json').send({ error: 'Invalid request' })
      return
    }

    try {
      const invoice =
        action === 'approve'
          ? await this.peeringBuyerService.approve(paymentHash)
          : await this.peeringBuyerService.reject(paymentHash)

      response
        .status(200)
        .setHeader('content-type', 'application/json')
        .send({ ok: true, invoice: serializePeeringInvoice(invoice) })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to update the peering invoice'
      response.status(400).setHeader('content-type', 'application/json').send({ error: message })
    }
  }
}
