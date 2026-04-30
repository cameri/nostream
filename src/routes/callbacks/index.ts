import { json, Router, urlencoded } from 'express'

import { createLNbitsCallbackController } from '../../factories/controllers/lnbits-callback-controller-factory'
import { createNodelessCallbackController } from '../../factories/controllers/nodeless-callback-controller-factory'
import { createOpenNodeCallbackController } from '../../factories/controllers/opennode-callback-controller-factory'
import { createSettings } from '../../factories/settings-factory'
import { createZebedeeCallbackController } from '../../factories/controllers/zebedee-callback-controller-factory'
import { withController } from '../../handlers/request-handlers/with-controller-request-handler'

const router: Router = Router()

const settings = createSettings()
const processor = settings.payments?.processor

router
  .post('/zebedee', json(), withController(createZebedeeCallbackController))
  .post('/lnbits', json(), withController(createLNbitsCallbackController))
  .post('/opennode', urlencoded({ extended: false }), json(), withController(createOpenNodeCallbackController))

if (processor === 'nodeless') {
  router.post(
    '/nodeless',
    json({
      verify(req, _res, buf) {
        ;(req as any).rawBody = buf
      },
    }),
    withController(createNodelessCallbackController),
  )
}

export default router
