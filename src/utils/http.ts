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

  const headerAddress = header
    ? request.headers[header]
    : undefined
  const socketAddress = request.socket.remoteAddress

  const trustedProxy = typeof socketAddress === 'string'
    && isTrustedProxy(socketAddress, settings)

  const result = trustedProxy && typeof headerAddress === 'string'
    ? headerAddress
    : socketAddress

  return (result as string).split(',')[0].trim()
}
