import { Request, Response } from 'express'

import { Factory } from '../../@types/base'
import { IController } from '../../@types/controllers'

export const withAdminController =
  (controllerFactory: Factory<IController>) => async (request: Request, response: Response) => {
    try {
      return await controllerFactory().handleRequest(request, response)
    } catch {
      response.status(500).setHeader('content-type', 'application/json').send({ error: 'Internal Server Error' })
    }
  }
