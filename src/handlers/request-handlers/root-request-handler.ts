import { NextFunction, Request, Response } from 'express'
import { path } from 'ramda'

import { createSettings } from '../../factories/settings-factory'

export const rootRequestHandler = (_req: Request, res: Response, next: NextFunction) => {
  const settings = createSettings()
  const admissionFeeEnabled = path(['payments','feeSchedules','admission', '0', 'enabled'])(settings)

  if (admissionFeeEnabled) {
    res.redirect(301, '/invoices')
  } else {
    res.status(200).setHeader('content-type', 'text/plain; charset=utf8').send('Please use a Nostr client to connect.')
  }
  next()
}
