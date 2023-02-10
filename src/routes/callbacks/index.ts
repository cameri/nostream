import { json, Router } from 'express'

import { createLogger } from '../../factories/logger-factory'
import { createSettings } from '../../factories/settings-factory'
import { getRemoteAddress } from '../../utils/http'
import { PaymentProcessors } from '../../factories/payments-processor-factory'
import { postLnbitsCallbackRequestHandler } from '../../handlers/request-handlers/post-lnbits-callback-request-handler'
import { postZebedeeCallbackRequestHandler } from '../../handlers/request-handlers/post-zebedee-callback-request-handler'
import { Settings } from '../../@types/settings'

const debug = createLogger('routes-callbacks')

const getWhitelist = (url: string, settings: Settings) => {
  let whiteList: string[] | undefined

  switch (url.slice(1)) {
    case PaymentProcessors.Lnbits:
      whiteList = settings.paymentsProcessors?.lnbits?.ipWhitelist
      break

    case PaymentProcessors.Zebedee:
      whiteList = settings.paymentsProcessors?.zebedee?.ipWhitelist
  }

  return whiteList || []
}

const router = Router()
router
  .use((req, res, next) => {
    const settings = createSettings()
    const ipWhitelist = getWhitelist(req.url, settings)
    const remoteAddress = getRemoteAddress(req, settings)

    if (ipWhitelist.length && !ipWhitelist.includes(remoteAddress)) {
      debug(`unauthorized request from %s to /callbacks${req.url}`, remoteAddress)
      res
        .status(403)
        .send('Forbidden')
      return
    }

    next()
  })
  .post('/zebedee', json(), postZebedeeCallbackRequestHandler)
  .post('/lnbits', json(), postLnbitsCallbackRequestHandler)

export default router

