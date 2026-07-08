import { Request, Response } from 'express'

export interface IAdminAuthProvider {
  handleLogin(request: Request, response: Response): Promise<void>
  isRequestAuthenticated(request: Request): Promise<boolean>
  getSessionExpiresAt(request: Request): number | undefined
}

export interface INip98ReplayGuard {
  /**
   * Returns true when eventId was not seen before (and is now registered),
   * false when the event id is being replayed.
   */
  registerEventId(eventId: string, ttlSeconds: number): Promise<boolean>
}
