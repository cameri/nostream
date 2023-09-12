import { Request, Response } from 'express'
import { createLogger } from '../../factories/logger-factory'
import { getRemoteAddress } from '../../utils/http'
import { IController } from '../../@types/controllers'
import { IRateLimiter } from '../../@types/utils'
import { IUserRepository } from '../../@types/repositories'
import { path } from 'ramda'
import { Settings } from '../../@types/settings'

const debug = createLogger('get-admission-check-controller')

export class GetSubmissionCheckController implements IController {
  public constructor(
    private readonly userRepository: IUserRepository,
    private readonly settings: () => Settings,
    private readonly rateLimiter: () => IRateLimiter,
  ){}

  public async handleRequest(request: Request, response: Response): Promise<void> {
    const currentSettings = this.settings()

    const limited = await this.isRateLimited(request, currentSettings)
    if (limited) {
      response
        .status(429)
        .setHeader('content-type', 'text/plain; charset=utf8')
        .send('Too many requests')
      return
    }
    
    const pubkey = request.params.pubkey
    const user = await this.userRepository.findByPubkey(pubkey)

    let userAdmitted = false

    const minBalance = currentSettings.limits?.event?.pubkey?.minBalance
    if (user && user.isAdmitted && (!minBalance || user.balance >= minBalance)) {
      userAdmitted = true
    }

    response
      .status(200)
      .setHeader('content-type', 'application/json; charset=utf8')
      .send({ userAdmitted })

    return
  }

  public async isRateLimited(request: Request, settings: Settings) {
    const rateLimits = path(['limits', 'admissionCheck', 'rateLimits'], settings)
    if (!Array.isArray(rateLimits) || !rateLimits.length) {
      return false
    }

    const ipWhitelist = path(['limits', 'admissionCheck', 'ipWhitelist'], settings)
    const remoteAddress = getRemoteAddress(request, settings)

    let limited = false
    if (Array.isArray(ipWhitelist) && !ipWhitelist.includes(remoteAddress)) {
      const rateLimiter = this.rateLimiter()
      for (const { rate, period } of rateLimits) {
        if (await rateLimiter.hit(`${remoteAddress}:admission-check:${period}`, 1, { period, rate })) {
          debug('rate limited %s: %d in %d milliseconds', remoteAddress, rate, period)
          limited = true
        }
      }
    }
    return limited
  }
}