import { Request, Response } from 'express'

import { Factory } from '../../@types/base'
import { IController } from '../../@types/controllers'

export const withController = (controllerFactory: Factory<IController>) => async (
  request: Request,
  response: Response,
) => {
  try {
    return await controllerFactory().handleRequest(request, response)
  } catch (error) {
    response
      .status(500)
      .setHeader('content-type', 'text/plain')
      .send('Error handling request')
  }
}
