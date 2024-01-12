import { createGetAdmissionCheckController } from '../../factories/controllers/get-admission-check-controller-factory'
import { Router } from 'express'
import { withController } from '../../handlers/request-handlers/with-controller-request-handler'

const admissionRouter = Router()

admissionRouter
  .get('/check/:pubkey', withController(createGetAdmissionCheckController))

export default admissionRouter