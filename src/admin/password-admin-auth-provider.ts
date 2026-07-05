import { Request, Response } from 'express'

import { IAdminAuthProvider } from '../@types/admin'
import { Settings } from '../@types/settings'
import { adminLoginBodySchema } from '../schemas/admin-login-schema'
import { verifyAdminPasswordHash, verifyPlaintextPassword } from '../utils/admin-password'
import {
  buildAdminSessionCookieHeader,
  createAdminSessionToken,
  getAdminSessionTokenFromRequest,
  isValidAdminSessionToken,
  parseAdminSessionToken,
  resolveAdminSessionTtlSeconds,
} from '../utils/admin-session'
import { validateSchema } from '../utils/validation'

export class PasswordAdminAuthProvider implements IAdminAuthProvider {
  public constructor(private readonly settings: () => Settings) {}

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

      response
        .status(200)
        .setHeader('content-type', 'application/json')
        .setHeader('Set-Cookie', buildAdminSessionCookieHeader(request, currentSettings, token, sessionTtlSeconds))
        .send({ authenticated: true, expiresAt })
    } catch {
      response.status(500).setHeader('content-type', 'application/json').send({ error: 'Internal Server Error' })
    }
  }

  public isRequestAuthenticated(request: Request): boolean {
    const token = this.getToken(request)
    return token ? isValidAdminSessionToken(token) : false
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
