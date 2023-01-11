import { Request, Response } from 'express'
import { createZebedeeCallbackController } from '../../factories/zebedee-callback-controller-factory'

export const postZebedeeCallbackRequestHandler = async (
  req: Request,
  res: Response,
) => {
  const controller = createZebedeeCallbackController()

  return controller.handleRequest(req, res)
}
