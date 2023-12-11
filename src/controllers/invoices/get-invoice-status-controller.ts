import { Request, Response } from 'express'
import { createLogger } from '../../factories/logger-factory'
import { IController } from '../../@types/controllers'
import { IInvoiceRepository } from '../../@types/repositories'

const debug = createLogger('get-invoice-status-controller')

export class GetInvoiceStatusController implements IController {
  public constructor(
    private readonly invoiceRepository: IInvoiceRepository,
  ) {}

  public async handleRequest(
    request: Request,
    response: Response,
  ): Promise<void> {
    const invoiceId = request.params.invoiceId
    if (typeof invoiceId !== 'string' || !invoiceId) {
      debug('invalid invoice id: %s', invoiceId)
      response
        .status(400)
        .setHeader('content-type', 'application/json; charset=utf8')
          .send({ id: invoiceId, status: 'invalid invoice' })
      return
    }

    try {
      debug('fetching invoice: %s', invoiceId)
      const invoice = await this.invoiceRepository.findById(invoiceId)

      if (!invoice) {
        debug('invoice not found: %s', invoiceId)
        response
          .status(404)
          .setHeader('content-type', 'application/json; charset=utf8')
          .send({ id: invoiceId, status: 'not found' })
        return
      }

      response
        .status(200)
        .setHeader('content-type', 'application/json; charset=utf8')
        .send({
          id: invoice.id,
          status: invoice.status,
        })
    } catch (error) {
      console.error(`get-invoice-status-controller: unable to get invoice ${invoiceId}:`, error)

      response
        .status(500)
        .setHeader('content-type', 'application/json; charset=utf8')
        .send({ id: invoiceId, status: 'error' })
    }
  }
}
