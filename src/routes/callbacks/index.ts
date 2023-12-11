import { json, Router } from 'express'

import { createLNbitsCallbackController } from '../../factories/controllers/lnbits-callback-controller-factory'
import { createNodelessCallbackController } from '../../factories/controllers/nodeless-callback-controller-factory'
import { createOpenNodeCallbackController } from '../../factories/controllers/opennode-callback-controller-factory'
import { createZebedeeCallbackController } from '../../factories/controllers/zebedee-callback-controller-factory'
import { withController } from '../../handlers/request-handlers/with-controller-request-handler'

const router = Router()

router
  .post('/zebedee', json(), withController(createZebedeeCallbackController))
  .post('/lnbits', json(), withController(createLNbitsCallbackController))
  .post('/nodeless', json({
    verify(req, _res, buf) {
      (req as any).rawBody = buf
    },
  }), withController(createNodelessCallbackController))
  .post('/opennode', json(), withController(createOpenNodeCallbackController))

export default router
