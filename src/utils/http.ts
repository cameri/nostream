import { IncomingMessage } from 'http'

import { Settings } from '../@types/settings'

export const getRemoteAddress = (request: IncomingMessage, settings: Settings): string => {
  let header: string | undefined
  // TODO: Remove deprecation warning
  if ('network' in settings && 'remote_ip_header' in settings.network) {
    console.warn(`WARNING: Setting network.remote_ip_header is deprecated and will be removed in a future version.
        Use network.remoteIpHeader instead.`)
    header = settings.network['remote_ip_header'] as string
  } else {
    header = settings.network.remoteIpHeader as string
  }

  const result = (request.headers[header] ?? request.socket.remoteAddress) as string

  return result.split(',')[0]
}
