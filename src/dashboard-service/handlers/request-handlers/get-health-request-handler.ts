import { withController } from '../../../handlers/request-handlers/with-controller-request-handler'

import { GetHealthController } from '../../controllers/get-health-controller'

export const getHealthRequestHandler = withController(() => new GetHealthController())