import { NextFunction, Request, Response } from 'express'
import { createLogger } from '../../factories/logger-factory'
import { createSettings } from '../../factories/settings-factory'
import { getRemoteAddress } from '../../utils/http'
import { Settings } from '../../@types/settings'
import { slidingWindowRateLimiterFactory } from '../../factories/rate-limiter-factory'

const debug = createLogger('rate-limiter-middleware')

export const rateLimiterMiddleware = async (request: Request, response: Response, next: NextFunction) => {
  const currentSettings = createSettings()

  const clientAddress = getRemoteAddress(request, currentSettings).split(',')[0]

  debug('request received from %s: %o', clientAddress, request.headers)

  if (await isRateLimited(clientAddress, currentSettings)) {
    response.destroy()

    return
  }

  next()
}

export async function isRateLimited(remoteAddress: string, settings: Settings): Promise<boolean> {
  const {
    rateLimits,
    ipWhitelist = [],
  } = settings.limits?.connection ?? {}

  if (typeof rateLimits === 'undefined') {
    return false
  }

  if (ipWhitelist.includes(remoteAddress)) {
    return false
  }

  const rateLimiter = slidingWindowRateLimiterFactory()

  const hit = (period: number, rate: number) =>
    rateLimiter.hit(
      `${remoteAddress}:connection:${period}`,
      1,
      { period: period, rate: rate },
    )

  let limited = false
  for (const { rate, period } of rateLimits) {
    const isRateLimited = await hit(period, rate)

    if (isRateLimited) {
      debug('rate limited %s: %d messages / %d ms exceeded', remoteAddress, rate, period)

      limited = true
    }
  }

  return limited
}
