import { Request, Response } from 'express'
import { IController } from '../../@types/controllers'
import { IInvoiceRepository } from '../../@types/repositories'

export class GetInvoiceStatusController implements IController {
  public constructor(
    private readonly invoiceRepository: IInvoiceRepository,
  ) {}

  public async handleRequest(
    request: Request,
    response: Response,
  ): Promise<void> {
    const invoiceId = request.params.invoiceId
    if (!invoiceId) {
      response
        .status(400)
        .setHeader('content-type', 'text/plain; charset=utf8')
        .send('Invalid invoice')
      return
    }

    try {
      const invoice = await this.invoiceRepository.findById(request.params.invoiceId)

      if (!invoice) {
        response
          .status(404)
          .setHeader('content-type', 'text/plain; charset=utf8')
          .send('Invoice not found')
        return
      }

      response
        .status(200)
        .setHeader('content-type', 'application/json; charset=utf8')
        .send(JSON.stringify({
          id: invoice.id,
          status: invoice.status,
        }))
    } catch (error) {
      console.error(`get-invoice-status-controller: unable to get invoice ${invoiceId}:`, error)

      response
        .status(500)
        .setHeader('content-type', 'text/plain; charset=utf8')
        .send('Unable to get invoice status')
    }
  }
}
