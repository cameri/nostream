import { Request, Response } from 'express'

export interface IAdminAuthProvider {
  handleLogin(request: Request, response: Response): Promise<void>
  isRequestAuthenticated(request: Request): boolean
  getSessionExpiresAt(request: Request): number | undefined
}
