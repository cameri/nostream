import { Request, Response } from 'express'
import { createPostInvoiceController } from '../../factories/post-invoice-controller-factory'

export const postInvoiceRequestHandler = async (
  req: Request,
  res: Response,
) => {
  const controller = createPostInvoiceController()

  try {
    await controller.handleRequest(req, res)
  } catch (error) {
    res
      .status(500)
      .setHeader('content-type', 'text-plain')
      .send('Error handling request')
  }
}
