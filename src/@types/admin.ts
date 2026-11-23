import { Request, Response } from 'express'

export interface IAdminAuthProvider {
  handleLogin(request: Request, response: Response): Promise<void>
  handleLogout(request: Request, response: Response): Promise<void>
  isRequestAuthenticated(request: Request): Promise<boolean>
  getSessionExpiresAt(request: Request): number | undefined
}

/**
 * Admin session tokens are signed, so the server cannot take one back by itself. Logout records the
 * token's session id here, until the token would have expired anyway, and every request checks it.
 */
export interface IAdminSessionRevocations {
  /** Resolves true when this call revoked the session, false when it was already revoked (the call changed nothing). */
  revoke(sessionId: string, ttlSeconds: number): Promise<boolean>
  isRevoked(sessionId: string): Promise<boolean>
}
