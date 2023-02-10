import { Request, Response } from 'express'
import { createLnbitsallbackController } from '../../factories/lnbits-callback-controller-factory'

export const postLnbitsCallbackRequestHandler = async (
  req: Request,
  res: Response,
) => {
  const controller = createLnbitsallbackController()

  try {
    await controller.handleRequest(req, res)
  } catch (error) {
    res
      .status(500)
      .setHeader('content-type', 'text-plain')
      .send('Error handling request')
  }
}
