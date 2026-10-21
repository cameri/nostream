import { path } from 'ramda'

import { Request, Response } from 'express'

import { IController } from '../../@types/controllers'
import { IRateLimiter } from '../../@types/utils'
import { IUserSubscriptionRepository } from '../../@types/repositories'
import { Settings } from '../../@types/settings'

import { createLogger } from '../../factories/logger-factory'

import { areSubscriptionsEnabled, getAccessEndsAt, hasSubscriptionAccess } from '../../utils/subscription'
import { fromBech32 } from '../../utils/transform'
import { getRemoteAddress } from '../../utils/http'

const logger = createLogger('get-subscription-status-controller')

export class GetSubscriptionStatusController implements IController {
  public constructor(
    private readonly userSubscriptionRepository: IUserSubscriptionRepository,
    private readonly settings: () => Settings,
    private readonly rateLimiter: () => IRateLimiter,
  ) {}

  public async handleRequest(request: Request, response: Response): Promise<void> {
    const currentSettings = this.settings()

    if (await this.isRateLimited(request, currentSettings)) {
      response.status(429).setHeader('content-type', 'text/plain; charset=utf8').send('Too many requests')
      return
    }

    if (!areSubscriptionsEnabled(currentSettings)) {
      response.status(404).setHeader('content-type', 'text/plain; charset=utf8').send('Subscriptions are not enabled')
      return
    }

    const pubkey = this.parsePubkey(request.query?.pubkey)
    if (!pubkey) {
      response.status(400).setHeader('content-type', 'text/plain; charset=utf8').send('Invalid pubkey')
      return
    }

    const subscription = await this.userSubscriptionRepository.findByPubkey(pubkey)

    // Without a row the user has no plan to report: they were never subscribed, or were admitted before plans.
    const body = subscription
      ? {
          pubkey,
          planId: subscription.planId,
          status: subscription.status,
          active: hasSubscriptionAccess(subscription, new Date()),
          currentPeriodEnd: subscription.currentPeriodEnd?.toISOString() ?? null,
          accessEndsAt: getAccessEndsAt(subscription)?.toISOString() ?? null,
        }
      : { pubkey, planId: null, status: null, active: false, currentPeriodEnd: null, accessEndsAt: null }

    response.status(200).setHeader('content-type', 'application/json; charset=utf8').send(body)
  }

  private parsePubkey(raw: unknown): string | undefined {
    if (typeof raw !== 'string') {
      return undefined
    }

    if (/^[0-9a-f]{64}$/.test(raw)) {
      return raw
    }

    if (/^npub1/.test(raw)) {
      try {
        return fromBech32(raw)
      } catch (_error) {
        return undefined
      }
    }

    return undefined
  }

  /** Shares the invoice limits, since this endpoint sits beside them. */
  private async isRateLimited(request: Request, settings: Settings): Promise<boolean> {
    const rateLimits = path(['limits', 'invoice', 'rateLimits'], settings)
    if (!Array.isArray(rateLimits) || !rateLimits.length) {
      return false
    }

    const ipWhitelist = path(['limits', 'invoice', 'ipWhitelist'], settings)
    const remoteAddress = getRemoteAddress(request, settings)

    let limited = false
    if (Array.isArray(ipWhitelist) && !ipWhitelist.includes(remoteAddress)) {
      const rateLimiter = this.rateLimiter()
      for (const { rate, period } of rateLimits) {
        if (await rateLimiter.hit(`${remoteAddress}:subscription-status:${period}`, 1, { period, rate })) {
          logger('rate limited %s: %d in %d milliseconds', remoteAddress, rate, period)
          limited = true
        }
      }
    }

    return limited
  }
}
