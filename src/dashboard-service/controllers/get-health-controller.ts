import { Request, Response } from 'express'

import { IController } from '../../@types/controllers'

export class GetHealthController implements IController {
  public async handleRequest(_request: Request, response: Response): Promise<void> {
    response
      .status(200)
      .setHeader('content-type', 'application/json; charset=utf-8')
      .send({ status: 'ok' })
  }
}