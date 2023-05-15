import { FeeSchedule, Settings } from '../../@types/settings'
import { fromBech32, toBech32 } from '../../utils/transform'
import { getPublicKey, getRelayPrivateKey } from '../../utils/event'
import { Request, Response } from 'express'

import { createLogger } from '../../factories/logger-factory'
import { getRemoteAddress } from '../../utils/http'
import { IController } from '../../@types/controllers'
import { Invoice } from '../../@types/invoice'
import { IPaymentsService } from '../../@types/services'
import { IRateLimiter } from '../../@types/utils'
import { IUserRepository } from '../../@types/repositories'
import { path } from 'ramda'
import { readFileSync } from 'fs'

let pageCache: string

const debug = createLogger('post-invoice-controller')

export class PostInvoiceController implements IController {
  public constructor(
    private readonly userRepository: IUserRepository,
    private readonly paymentsService: IPaymentsService,
    private readonly settings: () => Settings,
    private readonly rateLimiter: () => IRateLimiter,
  ){}

  public async handleRequest(request: Request, response: Response): Promise<void> {
    if (!pageCache) {
      pageCache = readFileSync('./resources/invoices.html', 'utf8')
    }

    debug('params: %o', request.params)
    debug('body: %o', request.body)

    const currentSettings = this.settings()

    const {
      info: { name: relayName, relay_url: relayUrl },
    } = currentSettings

    const limited = await this.isRateLimited(request, currentSettings)
    if (limited) {
      response
        .status(429)
        .setHeader('content-type', 'text/plain; charset=utf8')
        .send('Too many requests')
      return
    }

    if (!request.body || typeof request.body !== 'object') {
      response
        .status(400)
        .setHeader('content-type', 'text/plain; charset=utf8')
        .send('Invalid request')

      return
    }

    const tosAccepted = request.body?.tosAccepted === 'yes'

    if (!tosAccepted) {
      response
        .status(400)
        .setHeader('content-type', 'text/plain; charset=utf8')
        .send('ToS agreement: not accepted')

      return
    }

    const isAdmissionInvoice = request.body?.feeSchedule === 'admission'
    if (!isAdmissionInvoice) {
      response
        .status(400)
        .setHeader('content-type', 'text/plain; charset=utf8')
        .send('Invalid fee')

      return
    }

    const pubkeyRaw = path(['body', 'pubkey'], request)

    let pubkey: string
    if (typeof pubkeyRaw !== 'string') {
      response
        .status(400)
        .setHeader('content-type', 'text/plain; charset=utf8')
        .send('Invalid pubkey: missing')

      return
    } else if (/^[0-9a-f]{64}$/.test(pubkeyRaw)) {
      pubkey = pubkeyRaw
    } else if (/^npub1/.test(pubkeyRaw)) {
      try {
        pubkey = fromBech32(pubkeyRaw)
      } catch (error) {
        response
          .status(400)
          .setHeader('content-type', 'text/plain; charset=utf8')
          .send('Invalid pubkey: invalid npub')

        return
      }
    } else {
      response
        .status(400)
        .setHeader('content-type', 'text/plain; charset=utf8')
        .send('Invalid pubkey: unknown format')

      return
    }

    const isApplicableFee = (feeSchedule: FeeSchedule) => feeSchedule.enabled
      && !feeSchedule.whitelists?.pubkeys?.some((prefix) => pubkey.startsWith(prefix))
    const admissionFee = currentSettings.payments?.feeSchedules.admission
      .filter(isApplicableFee)

    if (!Array.isArray(admissionFee) || !admissionFee.length) {
      response
        .status(400)
        .setHeader('content-type', 'text/plain; charset=utf8')
        .send('No admission fee required')

      return
    }

    const minBalance = currentSettings.limits?.event?.pubkey?.minBalance
    const user = await this.userRepository.findByPubkey(pubkey)
    if (user && user.isAdmitted && (!minBalance || user.balance >= minBalance)) {
      response
        .status(400)
        .setHeader('content-type', 'text/plain; charset=utf8')
        .send('User is already admitted.')

      return
    }

    let invoice: Invoice
    const amount = admissionFee.reduce((sum, fee) => {
      return fee.enabled && !fee.whitelists?.pubkeys?.includes(pubkey)
        ? BigInt(fee.amount) + sum
        : sum
    }, 0n)

    try {
      const description = `${relayName} Admission Fee for ${toBech32('npub')(pubkey)}`

      invoice = await this.paymentsService.createInvoice(
        pubkey,
        amount,
        description,
      )
    } catch (error) {
      console.error('Unable to create invoice. Reason:', error)
      response
        .status(500)
        .setHeader('content-type', 'text/plain')
        .send('Unable to create invoice')
      return
    }

    const relayPrivkey = getRelayPrivateKey(relayUrl)
    const relayPubkey = getPublicKey(relayPrivkey)

    const replacements = {
      name: relayName,
      reference: invoice.id,
      relay_url: relayUrl,
      pubkey,
      relay_pubkey: relayPubkey,
      expires_at: invoice.expiresAt?.toISOString() ?? '',
      invoice: invoice.bolt11,
      amount: amount / 1000n,
      processor: currentSettings.payments.processor,
    }

    const body = Object
      .entries(replacements)
      .reduce((body, [key, value]) => body.replaceAll(`{{${key}}}`, value.toString()), pageCache)

    response
      .status(200)
      .setHeader('Content-Type', 'text/html; charset=utf8')
      .send(body)

    return
  }

  public async isRateLimited(request: Request, settings: Settings) {
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
        if (await rateLimiter.hit(`${remoteAddress}:invoice:${period}`, 1, { period, rate })) {
          debug('rate limited %s: %d in %d milliseconds', remoteAddress, rate, period)
          limited = true
        }
      }
    }
    return limited
  }
}