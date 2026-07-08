import { createHash } from 'crypto'
import { Request, Response } from 'express'

import { IAdminAuthProvider, INip98ReplayGuard } from '../@types/admin'
import { Settings } from '../@types/settings'
import {
  buildAdminSessionCookieHeader,
  createAdminSessionToken,
  getAdminSessionTokenFromRequest,
  isValidAdminSessionToken,
  parseAdminSessionToken,
  resolveAdminSessionTtlSeconds,
} from '../utils/admin-session'
import { getPublicRequestUrl } from '../utils/http'
import {
  DEFAULT_NIP98_TIMESTAMP_TOLERANCE_SECONDS,
  Nip98RequestContext,
  verifyNip98AuthorizationHeader,
} from '../utils/nip98'
import { fromBech32 } from '../utils/transform'

const HEX_PUBKEY_REGEX = /^[0-9a-f]{64}$/i
const NOSTR_SCHEME_PREFIX_REGEX = /^nostr\s/i

export class Nip98AdminAuthProvider implements IAdminAuthProvider {
  public constructor(
    private readonly settings: () => Settings,
    private readonly replayGuard: INip98ReplayGuard,
  ) {}

  public async handleLogin(request: Request, response: Response): Promise<void> {
    const auth = await this.authenticateNostrHeader(request)
    if (!auth) {
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
        .send({ authenticated: true, expiresAt, pubkey: auth.pubkey })
    } catch {
      response.status(500).setHeader('content-type', 'application/json').send({ error: 'Internal Server Error' })
    }
  }

  public async isRequestAuthenticated(request: Request): Promise<boolean> {
    const token = this.getToken(request)
    if (token && isValidAdminSessionToken(token)) {
      return true
    }

    const authorization = request.headers.authorization
    if (typeof authorization === 'string' && NOSTR_SCHEME_PREFIX_REGEX.test(authorization.trim())) {
      return (await this.authenticateNostrHeader(request)) !== undefined
    }

    return false
  }

  public getSessionExpiresAt(request: Request): number | undefined {
    const token = this.getToken(request)
    return token ? parseAdminSessionToken(token)?.expiresAt : undefined
  }

  private getToken(request: Request): string | undefined {
    return getAdminSessionTokenFromRequest(request.headers.authorization, request.headers.cookie)
  }

  private async authenticateNostrHeader(request: Request): Promise<{ pubkey: string } | undefined> {
    const context = this.buildContext(request)
    if (!context) {
      return undefined
    }

    const toleranceSeconds = this.getToleranceSeconds()
    const result = await verifyNip98AuthorizationHeader(request.headers.authorization, context, {
      timestampToleranceSeconds: toleranceSeconds,
    })
    if (!result.ok) {
      return undefined
    }

    if (!this.getAllowedPubkeys().has(result.event.pubkey.toLowerCase())) {
      return undefined
    }

    if (!(await this.replayGuard.registerEventId(result.event.id, toleranceSeconds * 2))) {
      return undefined
    }

    return { pubkey: result.event.pubkey }
  }

  private buildContext(request: Request): Nip98RequestContext | undefined {
    const url = getPublicRequestUrl(request, this.settings())
    if (!url) {
      return undefined
    }

    const bodySha256Hex = Buffer.isBuffer(request.body) && request.body.length > 0
      ? createHash('sha256').update(request.body).digest('hex')
      : undefined

    return { url, method: request.method, bodySha256Hex }
  }

  private getToleranceSeconds(): number {
    const configured = this.settings().admin?.authTimestampToleranceSeconds
    if (typeof configured === 'number' && Number.isFinite(configured) && configured > 0) {
      return Math.floor(configured)
    }

    return DEFAULT_NIP98_TIMESTAMP_TOLERANCE_SECONDS
  }

  private getAllowedPubkeys(): Set<string> {
    const entries = this.settings().admin?.pubkeys ?? []
    const allowed = new Set<string>()

    for (const entry of entries) {
      if (typeof entry !== 'string') {
        continue
      }

      if (HEX_PUBKEY_REGEX.test(entry)) {
        allowed.add(entry.toLowerCase())
        continue
      }

      if (entry.toLowerCase().startsWith('npub1')) {
        try {
          allowed.add(fromBech32(entry).toLowerCase())
        } catch {
          // invalid npub entries are skipped
        }
      }
    }

    return allowed
  }
}
