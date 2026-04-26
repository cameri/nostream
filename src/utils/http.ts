import { IncomingMessage } from 'http'

import { createLogger } from '../factories/logger-factory'
import { Settings } from '../@types/settings'

const logger = createLogger('http-utils')

const normalizeIpAddress = (input: string): string => {
  if (input.startsWith('::ffff:')) {
    return input.slice(7)
  }

  return input
}

const isTrustedProxy = (ipAddress: string, settings: Settings): boolean => {
  const trustedProxies = settings.network?.trustedProxies

  if (!Array.isArray(trustedProxies) || trustedProxies.length === 0) {
    return false
  }

  const normalizedRemote = normalizeIpAddress(ipAddress)

  return trustedProxies.some((trustedProxy) => {
    return normalizeIpAddress(trustedProxy) === normalizedRemote
  })
}

export const getRemoteAddress = (request: IncomingMessage, settings: Settings): string => {
  let header: string | undefined
  // TODO: Remove deprecation warning
  if ('network' in settings && 'remote_ip_header' in settings.network) {
    logger.warn(`WARNING: Setting network.remote_ip_header is deprecated and will be removed in a future version.
        Use network.remoteIpHeader instead.`)
    header = settings.network['remote_ip_header'] as string
  } else {
    header = settings.network.remoteIpHeader as string
  }

  const trustedProxies = settings.network?.trustedProxies
  if (header && (!Array.isArray(trustedProxies) || trustedProxies.length === 0)) {
    logger.warn('WARNING: network.remoteIpHeader is set but network.trustedProxies is empty. Forwarded headers will be ignored. Add your proxy IP to network.trustedProxies.')
  }

  const rawHeaderAddress = header ? request.headers[header] : undefined
  const headerAddress = Array.isArray(rawHeaderAddress) ? rawHeaderAddress[0] : rawHeaderAddress
  const socketAddress = request.socket.remoteAddress

  const trustedProxy = typeof socketAddress === 'string'
    && isTrustedProxy(socketAddress, settings)

  const result = trustedProxy && typeof headerAddress === 'string'
    ? headerAddress
    : socketAddress

  return (result as string).split(',')[0].trim()
}

const normalizePathPrefix = (pathPrefix: string | undefined): string => {
  if (typeof pathPrefix !== 'string') {
    return ''
  }

  const prefix = pathPrefix.split(',')[0].trim()

  if (!prefix.startsWith('/') || prefix.startsWith('//')) {
    return ''
  }

  try {
    const { pathname } = new URL(prefix, 'http://nostream.local')
    const normalized = pathname.replace(/\/+$/, '')

    return normalized === '/' ? '' : normalized
  } catch {
    return ''
  }
}

const getRelayUrlPathPrefix = (relayUrl: string | undefined): string => {
  if (typeof relayUrl !== 'string') {
    return ''
  }

  try {
    return normalizePathPrefix(new URL(relayUrl).pathname)
  } catch {
    return ''
  }
}

const getTrustedForwardedPathPrefix = (request: IncomingMessage, settings: Settings): string => {
  const socketAddress = request.socket?.remoteAddress
  if (typeof socketAddress !== 'string' || !isTrustedProxy(socketAddress, settings)) {
    return ''
  }

  const rawHeader = request.headers?.['x-forwarded-prefix']
  const rawPrefix = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader

  return normalizePathPrefix(rawPrefix)
}

export const getPublicPathPrefix = (request: IncomingMessage, settings: Settings): string => {
  return getTrustedForwardedPathPrefix(request, settings) || getRelayUrlPathPrefix(settings.info?.relay_url)
}

export const joinPathPrefix = (prefix: string, path: string): string => {
  const normalizedPrefix = prefix.replace(/\/+$/, '')
  const normalizedPath = path.startsWith('/') ? path : `/${path}`

  return `${normalizedPrefix}${normalizedPath}`
}
