import { json, Router } from 'express'

import { postZebedeeCallbackRequestHandler } from '../../handlers/request-handlers/post-zebedee-callback-request-handler'

const router = Router()

router.post('/zebedee', json(), postZebedeeCallbackRequestHandler)

export default router

