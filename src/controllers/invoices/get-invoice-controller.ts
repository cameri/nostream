import { escapeHtml, safeJsonForScript } from '../../utils/html'
import { path, pathEq } from 'ramda'
import { Request, Response } from 'express'

import { createSettings } from '../../factories/settings-factory'

import { FeeSchedule } from '../../@types/settings'
import { IController } from '../../@types/controllers'

import { getTemplate } from '../../utils/template-cache'
import { getPublicPathPrefix } from '../../utils/http'

export class GetInvoiceController implements IController {
  public async handleRequest(req: Request, res: Response): Promise<void> {
    const settings = createSettings()

    if (
      pathEq(['payments', 'enabled'], true, settings) &&
      pathEq(['payments', 'feeSchedules', 'admission', '0', 'enabled'], true, settings)
    ) {
      const name = path<string>(['info', 'name'])(settings)
      const feeSchedule = path<FeeSchedule>(['payments', 'feeSchedules', 'admission', '0'], settings)
      const page = getTemplate('./resources/get-invoice.html')
        .replaceAll('{{name}}', escapeHtml(name))
        .replaceAll('{{path_prefix}}', escapeHtml(getPublicPathPrefix(req, settings)))
        .replaceAll('{{processor_json}}', safeJsonForScript(settings.payments.processor))
        .replaceAll('{{amount}}', (BigInt(feeSchedule.amount) / 1000n).toString())
        .replaceAll('{{nonce}}', res.locals.nonce)

      res.status(200).setHeader('content-type', 'text/html; charset=utf8').send(page)
    } else {
      res.status(404).send()
    }
  }
}
