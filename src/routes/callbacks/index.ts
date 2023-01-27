import { json, Router } from 'express'

import { createLogger } from '../../factories/logger-factory'
import { createSettings } from '../../factories/settings-factory'
import { getRemoteAddress } from '../../utils/http'
import { postZebedeeCallbackRequestHandler } from '../../handlers/request-handlers/post-zebedee-callback-request-handler'

const debug = createLogger('routes-callbacks')

const router = Router()
router
  .use((req, res, next) => {
    const settings = createSettings()
    const { ipWhitelist = [] } = settings.paymentsProcessors?.zebedee ?? {}
    const remoteAddress = getRemoteAddress(req, settings)

    if (ipWhitelist.length && !ipWhitelist.includes(remoteAddress)) {
      debug('unauthorized request from %s to /callbacks/zebedee', remoteAddress)
      res
        .status(403)
        .send('Forbidden')
      return
    }

    next()
  })
  .post('/zebedee', json(), postZebedeeCallbackRequestHandler)

export default router

