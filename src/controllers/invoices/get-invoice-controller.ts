import { path, pathEq } from 'ramda'
import { Request, Response } from 'express'
import { readFileSync } from 'fs'

import { createSettings } from '../../factories/settings-factory'
import { FeeSchedule } from '../../@types/settings'
import { IController } from '../../@types/controllers'

let pageCache: string

export class GetInvoiceController implements IController {
  public async handleRequest(
    _req: Request,
    res: Response,
  ): Promise<void> {
    const settings = createSettings()

    if (pathEq(['payments', 'enabled'], true, settings)
      && pathEq(['payments', 'feeSchedules', 'admission', '0', 'enabled'], true, settings)) {
      if (!pageCache) {
        const name = path<string>(['info', 'name'])(settings)
        const feeSchedule = path<FeeSchedule>(['payments', 'feeSchedules', 'admission', '0'], settings)
        pageCache = readFileSync('./resources/index.html', 'utf8')
          .replaceAll('{{name}}', name)
          .replaceAll('{{processor}}', settings.payments.processor)
          .replaceAll('{{amount}}', (BigInt(feeSchedule.amount) / 1000n).toString())
      }

      res.status(200).setHeader('content-type', 'text/html; charset=utf8').send(pageCache)
    } else {
      res.status(404).send()
    }
  }
}