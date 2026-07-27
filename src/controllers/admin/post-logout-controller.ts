import { Request, Response } from 'express'

import { IAdminAuthProvider } from '../../@types/admin'
import { IController } from '../../@types/controllers'

export class PostAdminLogoutController implements IController {
  public constructor(private readonly authProvider: IAdminAuthProvider) {}

  public async handleRequest(request: Request, response: Response): Promise<void> {
    this.authProvider.handleLogout(request, response)
  }
}
