import { Request, Response } from 'express'

import { createLNbitsCallbackController } from '../../factories/lnbits-callback-controller-factory'

export const postLNbitsCallbackRequestHandler = async (
  req: Request,
  res: Response,
) => {
  const controller = createLNbitsCallbackController()

  try {
    await controller.handleRequest(req, res)
  } catch (error) {
    console.error('error while handling LNbits request: %o', error)
    res
      .status(500)
      .setHeader('content-type', 'text/plain')
      .send('Error handling request')
  }
}
