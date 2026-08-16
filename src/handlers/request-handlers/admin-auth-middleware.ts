import { NextFunction, Response } from 'express'

import { IAdminAuthProvider } from '../../@types/admin'
import { createAdminAuthProvider } from '../../factories/admin-auth-provider-factory'
import { createLogger } from '../../factories/logger-factory'
import { createSettings } from '../../factories/settings-factory'
import { getAbsoluteHttpRequestUrl } from '../../utils/http'
import {
  DEFAULT_NIP98_MAX_AUTHORIZATION_HEADER_LENGTH,
  isNostrAuthorizationHeader,
  verifyNip98Auth,
} from '../../utils/nip98'
import { claimNip98AuthEventId, resolveNip98ReplayTtlSeconds } from '../../utils/nip98-replay'
import { AdminRequest } from './admin-json-body-middleware'

const logger = createLogger('admin-auth-middleware')

const adminAuthProvider: IAdminAuthProvider = createAdminAuthProvider()

const METHODS_WITH_BODY = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

const isAllowedNip98Pubkey = (pubkey: string, allowedPubkeys: string[] = []): boolean => {
  const normalized = pubkey.toLowerCase()
  return allowedPubkeys.some((allowed) => allowed.toLowerCase() === normalized)
}

const resolveBodyForNip98 = (request: AdminRequest): Buffer | undefined => {
  if (!METHODS_WITH_BODY.has(request.method.toUpperCase())) {
    return undefined
  }

  return request.rawBody ?? Buffer.alloc(0)
}

const sendUnauthorized = (response: Response): void => {
  response.status(401).setHeader('content-type', 'application/json').send({ error: 'Unauthorized' })
}

export const adminAuthGateMiddleware = async (request: AdminRequest, response: Response, next: NextFunction) => {
  try {
    if (adminAuthProvider.isRequestAuthenticated(request)) {
      next()
      return
    }

    const settings = createSettings()
    const nip98Settings = settings.admin?.nip98
    const authorizationHeader = request.headers.authorization

    if (nip98Settings?.enabled !== true || !isNostrAuthorizationHeader(authorizationHeader)) {
      sendUnauthorized(response)
      return
    }

    if (authorizationHeader.length > DEFAULT_NIP98_MAX_AUTHORIZATION_HEADER_LENGTH) {
      logger('rejecting NIP-98 auth gate: authorization header too large')
      sendUnauthorized(response)
      return
    }

    const absoluteUrl = getAbsoluteHttpRequestUrl(request, settings)
    if (!absoluteUrl) {
      logger('rejecting NIP-98 auth gate: unable to build absolute request URL')
      sendUnauthorized(response)
      return
    }

    const result = await verifyNip98Auth({
      authorizationHeader,
      url: absoluteUrl,
      method: request.method.toUpperCase(),
      maxSkewSeconds: nip98Settings.maxSkewSeconds,
    })

    if (result.ok === false) {
      logger('rejecting NIP-98 auth gate: %s', result.reason)
      sendUnauthorized(response)
      return
    }

    if (!isAllowedNip98Pubkey(result.pubkey, nip98Settings.allowedPubkeys)) {
      logger('rejecting NIP-98 auth gate: pubkey %s is not allowlisted', result.pubkey)
      sendUnauthorized(response)
      return
    }

    next()
  } catch (error) {
    logger('admin auth gate error: %o', error)
    response.status(500).setHeader('content-type', 'application/json').send({ error: 'Internal Server Error' })
  }
}

export const adminAuthMiddleware = async (request: AdminRequest, response: Response, next: NextFunction) => {
  try {
    if (adminAuthProvider.isRequestAuthenticated(request)) {
      next()
      return
    }

    const settings = createSettings()
    const nip98Settings = settings.admin?.nip98
    const authorizationHeader = request.headers.authorization

    if (!nip98Settings?.enabled || !isNostrAuthorizationHeader(authorizationHeader)) {
      sendUnauthorized(response)
      return
    }

    const absoluteUrl = getAbsoluteHttpRequestUrl(request, settings)
    if (!absoluteUrl) {
      logger('rejecting NIP-98 auth: unable to build absolute request URL')
      sendUnauthorized(response)
      return
    }

    const result = await verifyNip98Auth({
      authorizationHeader,
      url: absoluteUrl,
      method: request.method.toUpperCase(),
      body: resolveBodyForNip98(request),
      maxSkewSeconds: nip98Settings.maxSkewSeconds,
      payloadPolicy: 'require-when-body',
    })

    if (result.ok === false) {
      logger('rejecting NIP-98 auth: %s', result.reason)
      sendUnauthorized(response)
      return
    }

    if (!isAllowedNip98Pubkey(result.pubkey, nip98Settings.allowedPubkeys)) {
      logger('rejecting NIP-98 auth: pubkey %s is not allowlisted', result.pubkey)
      sendUnauthorized(response)
      return
    }

    const claim = await claimNip98AuthEventId(
      result.event.id,
      resolveNip98ReplayTtlSeconds(result.event.created_at, nip98Settings.maxSkewSeconds),
    )
    if (claim !== 'claimed') {
      logger('rejecting NIP-98 auth: event %s replay protection result=%s', result.event.id, claim)
      sendUnauthorized(response)
      return
    }

    request.nip98Pubkey = result.pubkey
    next()
  } catch (error) {
    logger('admin auth middleware error: %o', error)
    response.status(500).setHeader('content-type', 'application/json').send({ error: 'Internal Server Error' })
  }
}
