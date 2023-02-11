import { json, Router } from 'express'

import { createLogger } from '../../factories/logger-factory'
import { createSettings } from '../../factories/settings-factory'
import { getRemoteAddress } from '../../utils/http'
import { postLNbitsCallbackRequestHandler } from '../../handlers/request-handlers/post-lnbits-callback-request-handler'
import { postZebedeeCallbackRequestHandler } from '../../handlers/request-handlers/post-zebedee-callback-request-handler'

const debug = createLogger('routes-callbacks')

const router = Router()
router
  .post('/zebedee', json(), (req, res) => {
    const settings = createSettings()
    const { ipWhitelist = [] } = settings.paymentsProcessors?.zebedee ?? {}
    const remoteAddress = getRemoteAddress(req, settings)
    const paymentProcessor = settings.payments?.processor ?? 'null'

    if (ipWhitelist.length && !ipWhitelist.includes(remoteAddress)) {
      debug('unauthorized request from %s to /callbacks/zebedee', remoteAddress)
      res
        .status(403)
        .send('Forbidden')
      return
    }

    if (paymentProcessor !== 'zebedee') {
      debug('denied request from %s to /callbacks/zebedee which is not the current payment processor', remoteAddress)
      res
        .status(403)
        .send('Forbidden')
      return
    }

    postZebedeeCallbackRequestHandler(req, res)
  })
  .post('/lnbits', json(), (req, res) => {
    const settings = createSettings()
    const { ipWhitelist = [] } = settings.paymentsProcessors?.lnbits ?? {}
    const remoteAddress = getRemoteAddress(req, settings)
    const paymentProcessor = settings.payments?.processor ?? 'null'

    if (ipWhitelist.length && !ipWhitelist.includes(remoteAddress)) {
      debug('unauthorized request from %s to /callbacks/lnbits', remoteAddress)
      res
        .status(403)
        .send('Forbidden')
      return
    }

    if (paymentProcessor !== 'lnbits') {
      debug('denied request from %s to /callbacks/lnbits which is not the current payment processor', remoteAddress)
      res
        .status(403)
        .send('Forbidden')
      return
    }

    postLNbitsCallbackRequestHandler(req, res)
  })

export default router

