import { timingSafeEqual } from 'crypto'
import { IncomingMessage } from 'http'

import { Settings } from '../@types/settings'
import { getPublicPathPrefix, isSecureRequest, joinPathPrefix } from './http'
import { deriveFromSecret, hmacSha256 } from './secret'

export const DEFAULT_ADMIN_SESSION_TTL_SECONDS = 86400

export const resolveAdminSessionTtlSeconds = (
  sessionTtlSeconds: number | undefined,
  defaultTtlSeconds = DEFAULT_ADMIN_SESSION_TTL_SECONDS,
): number => {
  if (typeof sessionTtlSeconds === 'number' && Number.isFinite(sessionTtlSeconds) && sessionTtlSeconds > 0) {
    return Math.floor(sessionTtlSeconds)
  }

  return defaultTtlSeconds
}

export const buildAdminSessionCookieHeader = (
  request: IncomingMessage,
  settings: Settings,
  token: string,
  maxAgeSeconds: number,
): string => {
  const cookiePath = joinPathPrefix(getPublicPathPrefix(request, settings), '/admin')
  const secure = isSecureRequest(request, settings) ? '; Secure' : ''

  return `admin_session=${token}; Path=${cookiePath}; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSeconds}${secure}`
}

export const createAdminSessionToken = (expiresAt: number): string => {
  const signature = hmacSha256(deriveFromSecret('admin-session'), `${expiresAt}`).toString('hex')
  return `${expiresAt}.${signature}`
}

export const parseAdminSessionToken = (token: string): { expiresAt: number } | undefined => {
  const separatorIndex = token.indexOf('.')
  if (separatorIndex <= 0) {
    return undefined
  }

  const expiresAt = Number(token.slice(0, separatorIndex))
  if (!Number.isFinite(expiresAt)) {
    return undefined
  }

  return { expiresAt }
}

export const isValidAdminSessionToken = (token: string, nowSeconds = Math.floor(Date.now() / 1000)): boolean => {
  const separatorIndex = token.indexOf('.')
  if (separatorIndex <= 0) {
    return false
  }

  const expiresAt = Number(token.slice(0, separatorIndex))
  const signature = token.slice(separatorIndex + 1)

  if (!Number.isFinite(expiresAt) || expiresAt <= nowSeconds || !/^[0-9a-f]+$/.test(signature)) {
    return false
  }

  const expected = hmacSha256(deriveFromSecret('admin-session'), `${expiresAt}`).toString('hex')
  const expectedBuf = Buffer.from(expected, 'utf8')
  const actualBuf = Buffer.from(signature, 'utf8')

  if (expectedBuf.length !== actualBuf.length) {
    return false
  }

  return timingSafeEqual(expectedBuf, actualBuf)
}

export const getAdminSessionTokenFromRequest = (authorizationHeader?: string, cookieHeader?: string): string | undefined => {
  if (authorizationHeader?.startsWith('Bearer ')) {
    const token = authorizationHeader.slice('Bearer '.length).trim()
    return token.length > 0 ? token : undefined
  }

  if (!cookieHeader) {
    return undefined
  }

  for (const part of cookieHeader.split(';')) {
    const [name, ...valueParts] = part.trim().split('=')
    if (name === 'admin_session') {
      const value = valueParts.join('=').trim()
      return value.length > 0 ? value : undefined
    }
  }

  return undefined
}
