import { NextFunction, Request, Response } from 'express'
import { path, pathEq } from 'ramda'
import { readFileSync } from 'fs'

import { createSettings } from '../../factories/settings-factory'
import { FeeSchedule } from '../../@types/settings'

let pageCache: string

export const getInvoiceRequestHandler = (_req: Request, res: Response, next: NextFunction) => {
  const settings = createSettings()

  if (pathEq(['payments', 'enabled'], true, settings)
   && pathEq(['payments', 'feeSchedules', 'admission', '0', 'enabled'], true, settings)) {
    if (!pageCache) {
      const name = path<string>(['info', 'name'])(settings)
      const feeSchedule = path<FeeSchedule>(['payments', 'feeSchedules', 'admission', '0'], settings)
      pageCache = readFileSync('./resources/index.html', 'utf8')
        .replaceAll('{{name}}', name)
        .replaceAll('{{amount}}', (BigInt(feeSchedule.amount) / 1000n).toString())
    }

    res.status(200).setHeader('content-type', 'text/html; charset=utf8').send(pageCache)
  } else {
    res.status(404).send()
  }

  next()
}
