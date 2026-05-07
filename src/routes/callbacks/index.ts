import { json, NextFunction, Request, Response, Router, urlencoded } from 'express'

import { createLNbitsCallbackController } from '../../factories/controllers/lnbits-callback-controller-factory'
import { createNodelessCallbackController } from '../../factories/controllers/nodeless-callback-controller-factory'
import { createOpenNodeCallbackController } from '../../factories/controllers/opennode-callback-controller-factory'
import { createSettings } from '../../factories/settings-factory'
import { createZebedeeCallbackController } from '../../factories/controllers/zebedee-callback-controller-factory'
import { withController } from '../../handlers/request-handlers/with-controller-request-handler'

const router: Router = Router()

const requireProcessor = (name: string) =>
  (_req: Request, res: Response, next: NextFunction) => {
    const settings = createSettings()
    if (settings.payments?.processor !== name) {
      res.status(403).send('Forbidden')
      return
    }
    next()
  }

router
  .post('/zebedee', requireProcessor('zebedee'), json(), withController(createZebedeeCallbackController))
  .post('/lnbits', requireProcessor('lnbits'), json(), withController(createLNbitsCallbackController))
  .post('/opennode', requireProcessor('opennode'), urlencoded({ extended: false }), json(), withController(createOpenNodeCallbackController))
  .post(
    '/nodeless',
    requireProcessor('nodeless'),
    json({
      verify(req, _res, buf) {
        ;(req as any).rawBody = buf
      },
    }),
    withController(createNodelessCallbackController),
  )

export default router

