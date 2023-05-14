import { Request, Response } from 'express'
import { createNodelessCallbackController } from '../../factories/nodeless-callback-controller-factory'

export const postNodelessCallbackRequestHandler = async (
  req: Request,
  res: Response,
) => {
  const controller = createNodelessCallbackController()

  try {
    await controller.handleRequest(req, res)
  } catch (error) {
    res
      .status(500)
      .setHeader('content-type', 'text/plain')
      .send('Error handling request')
  }
}
