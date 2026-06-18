import { path } from 'ramda'
import { Request } from 'express'

import { Settings } from '../@types/settings'
import { IRateLimiter } from '../@types/utils'
import { createLogger } from '../factories/logger-factory'
import { getRemoteAddress } from './http'

const logger = createLogger('admin-rate-limit')

export async function isAdminRateLimited(
  request: Request,
  settings: Settings,
  rateLimiterFactory: () => IRateLimiter,
  scope: 'login' | 'admin',
): Promise<boolean> {
  const rateLimitsKey = scope === 'login' ? 'loginRateLimits' : 'rateLimits'
  const rateLimits = path(['limits', 'admin', rateLimitsKey], settings)
  if (!Array.isArray(rateLimits) || !rateLimits.length) {
    return false
  }

  const ipWhitelist = path(['limits', 'admin', 'ipWhitelist'], settings)
  const remoteAddress = getRemoteAddress(request, settings)

  let limited = false
  if (Array.isArray(ipWhitelist) && !ipWhitelist.includes(remoteAddress)) {
    const rateLimiter = rateLimiterFactory()
    for (const { rate, period } of rateLimits) {
      if (await rateLimiter.hit(`${remoteAddress}:admin-${scope}:${period}`, 1, { period, rate })) {
        logger('rate limited %s: %d in %d milliseconds', remoteAddress, rate, period)
        limited = true
      }
    }
  }

  return limited
}
