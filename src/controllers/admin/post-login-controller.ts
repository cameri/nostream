import { Request, Response } from 'express'

import { IAdminAuthProvider } from '../../@types/admin'
import { IController } from '../../@types/controllers'

export class PostAdminLoginController implements IController {
  public constructor(private readonly authProvider: IAdminAuthProvider) {}

  public async handleRequest(request: Request, response: Response): Promise<void> {
    await this.authProvider.handleLogin(request, response)
  }
}
