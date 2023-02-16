import { deriveFromSecret, hmacSha256 } from '../../utils/secret'
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
    const remoteAddress = getRemoteAddress(req, settings)
    const paymentProcessor = settings.payments?.processor ?? 'null'

    if (paymentProcessor !== 'lnbits') {
      debug('denied request from %s to /callbacks/lnbits which is not the current payment processor', remoteAddress)
      res
        .status(403)
        .send('Forbidden')
      return
    }

    let validationPassed = false
    
    if (typeof req.query.hmac === 'string' && req.query.hmac.match(/^[0-9]{1,20}:[0-9a-f]{64}$/)) {
      const split = req.query.hmac.split(':')
      if (hmacSha256(deriveFromSecret('lnbits-callback-hmac-key'), split[0]).toString('hex') === split[1]) {
        if (parseInt(split[0]) > Date.now()) {
          validationPassed = true
        }
      }
    }

    if (!validationPassed) {
      debug('unauthorized request from %s to /callbacks/lnbits', remoteAddress)
      res
        .status(403)
        .send('Forbidden')
      return
    }
    postLNbitsCallbackRequestHandler(req, res)
  })

export default router

