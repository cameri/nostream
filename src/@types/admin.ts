import { Request, Response } from 'express'

export interface IAdminAuthProvider {
  handleLogin(request: Request, response: Response): Promise<void>
  handleLogout(request: Request, response: Response): void
  isRequestAuthenticated(request: Request): boolean
  getSessionExpiresAt(request: Request): number | undefined
}
