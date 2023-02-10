
import { CallbackHandler } from './handle-callback'
import { createLogger } from '../../factories/logger-factory'
import { Invoice } from '../../@types/invoice'
import { IPaymentsService } from '../../@types/services'

const debug = createLogger('lnbits-callback-controller')

export class LnbitsCallbackController extends CallbackHandler {
  public constructor(
    paymentsService: IPaymentsService,
  ) {
    super(debug, paymentsService)
  }

  protected parseInvoice = (body: any): Promise<Invoice> => {
    return this.paymentsService.getInvoiceFromPaymentsProcessor(body.extra.id)
  }
}
