import { Request, Response } from 'express'

import { IAdminAuthProvider } from '../../@types/admin'
import { IController } from '../../@types/controllers'

export class GetAdminSessionController implements IController {
  public constructor(private readonly authProvider: IAdminAuthProvider) {}

  public async handleRequest(request: Request, response: Response): Promise<void> {
    response.status(200).setHeader('content-type', 'application/json').send({
      authenticated: true,
      expiresAt: this.authProvider.getSessionExpiresAt(request),
    })
  }
}
