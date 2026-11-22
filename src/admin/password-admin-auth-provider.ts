import { Request, Response } from 'express'

import { IAdminAuthProvider, IAdminSessionRevocations } from '../@types/admin'
import { Settings } from '../@types/settings'
import { createLogger } from '../factories/logger-factory'
import { adminLoginBodySchema } from '../schemas/admin-login-schema'
import { verifyAdminPasswordHash, verifyPlaintextPassword } from '../utils/admin-password'
import {
  buildAdminSessionClearCookieHeader,
  buildAdminSessionCookieHeader,
  createAdminSessionToken,
  getAdminSessionTokenFromRequest,
  isValidAdminSessionToken,
  parseAdminSessionToken,
  resolveAdminSessionTtlSeconds,
} from '../utils/admin-session'
import { CacheAdminSessionRevocations } from '../utils/admin-session-revocations'
import { validateSchema } from '../utils/validation'

const logger = createLogger('password-admin-auth-provider')

export type AdminAuthAuditHook = (event: 'login' | 'logout', request: Request) => void | Promise<void>

export class PasswordAdminAuthProvider implements IAdminAuthProvider {
  public constructor(
    private readonly settings: () => Settings,
    private readonly auditHook?: AdminAuthAuditHook,
    private readonly sessionRevocations: IAdminSessionRevocations = new CacheAdminSessionRevocations(),
  ) {}

  public async handleLogin(request: Request, response: Response): Promise<void> {
    const validation = validateSchema(adminLoginBodySchema)(request.body)
    if (validation.error) {
      response.status(400).setHeader('content-type', 'application/json').send({ error: 'Invalid request' })
      return
    }

    if (!this.verifyPassword(validation.value.password)) {
      response.status(401).setHeader('content-type', 'application/json').send({ error: 'Unauthorized' })
      return
    }

    const currentSettings = this.settings()
    const sessionTtlSeconds = resolveAdminSessionTtlSeconds(currentSettings.admin?.sessionTtlSeconds)
    const expiresAt = Math.floor(Date.now() / 1000) + sessionTtlSeconds

    try {
      const token = createAdminSessionToken(expiresAt)

      void this.auditHook?.('login', request)

      response
        .status(200)
        .setHeader('content-type', 'application/json')
        .setHeader('Set-Cookie', buildAdminSessionCookieHeader(request, currentSettings, token, sessionTtlSeconds))
        .send({ authenticated: true, expiresAt })
    } catch {
      response.status(500).setHeader('content-type', 'application/json').send({ error: 'Internal Server Error' })
    }
  }

  public async handleLogout(request: Request, response: Response): Promise<void> {
    const currentSettings = this.settings()
    const clearCookie = buildAdminSessionClearCookieHeader(request, currentSettings)
    const token = this.getToken(request)
    const session = token && isValidAdminSessionToken(token) ? parseAdminSessionToken(token) : undefined

    if (session) {
      // The token is signed, so only a record of its session id can end it before it expires.
      try {
        const remainingSeconds = session.expiresAt - Math.floor(Date.now() / 1000)
        await this.sessionRevocations.revoke(session.sessionId, remainingSeconds + 1)
      } catch (error) {
        logger.error('unable to revoke the admin session at logout: %o', error)
        response
          .status(500)
          .setHeader('content-type', 'application/json')
          .setHeader('Set-Cookie', clearCookie)
          .send({ error: 'Internal Server Error' })
        return
      }

      // Recorded only for a request that presents a valid session. The endpoint is public (it has to clear a cookie
      // whoever sends the request), so an entry written for any request would let an anonymous caller fill the shared,
      // size-limited audit history with logouts that never happened and push real administrator records out of it.
      void this.auditHook?.('logout', request)
    }

    response
      .status(200)
      .setHeader('content-type', 'application/json')
      .setHeader('Set-Cookie', clearCookie)
      .send({ authenticated: false })
  }

  public async isRequestAuthenticated(request: Request): Promise<boolean> {
    const token = this.getToken(request)
    if (!token || !isValidAdminSessionToken(token)) {
      return false
    }

    const session = parseAdminSessionToken(token)
    if (!session) {
      return false
    }

    try {
      return !(await this.sessionRevocations.isRevoked(session.sessionId))
    } catch (error) {
      // Without the revocation list a logged-out token cannot be told from a live one.
      logger.error('unable to check whether the admin session was revoked: %o', error)
      return false
    }
  }

  public getSessionExpiresAt(request: Request): number | undefined {
    const token = this.getToken(request)
    return token ? parseAdminSessionToken(token)?.expiresAt : undefined
  }

  private getToken(request: Request): string | undefined {
    return getAdminSessionTokenFromRequest(request.headers.authorization, request.headers.cookie)
  }

  private verifyPassword(password: string): boolean {
    const envPassword = process.env.ADMIN_PASSWORD
    if (typeof envPassword === 'string' && envPassword.length > 0) {
      return verifyPlaintextPassword(password, envPassword)
    }

    const passwordHash = this.settings().admin?.passwordHash
    if (!passwordHash) {
      return false
    }

    return verifyAdminPasswordHash(password, passwordHash)
  }
}
