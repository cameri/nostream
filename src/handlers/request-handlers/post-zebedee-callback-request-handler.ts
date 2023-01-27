import { Request, Response } from 'express'
import { createZebedeeCallbackController } from '../../factories/zebedee-callback-controller-factory'

export const postZebedeeCallbackRequestHandler = async (
  req: Request,
  res: Response,
) => {
  const controller = createZebedeeCallbackController()

  try {
    await controller.handleRequest(req, res)
  } catch (error) {
    res
      .status(500)
      .setHeader('content-type', 'text-plain')
      .send('Error handling request')
  }
}
