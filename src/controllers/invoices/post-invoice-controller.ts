import { path } from 'ramda'

import { Request, Response } from 'express'

import { FeeSchedule, Settings } from '../../@types/settings'
import { IController } from '../../@types/controllers'
import { Invoice } from '../../@types/invoice'
import { IPaymentsService } from '../../@types/services'
import { IRateLimiter } from '../../@types/utils'
import { IUserRepository } from '../../@types/repositories'

import { createLogger } from '../../factories/logger-factory'

import { escapeHtml, safeJsonForScript } from '../../utils/html'
import { fromBech32, toBech32 } from '../../utils/transform'
import { getPublicKey, getRelayPrivateKey } from '../../utils/event'
import { getPublicPathPrefix, getRemoteAddress } from '../../utils/http'
import { getTemplate } from '../../utils/template-cache'

const logger = createLogger('post-invoice-controller')

export class PostInvoiceController implements IController {
  public constructor(
    private readonly userRepository: IUserRepository,
    private readonly paymentsService: IPaymentsService,
    private readonly settings: () => Settings,
    private readonly rateLimiter: () => IRateLimiter,
  ) {}

  public async handleRequest(request: Request, response: Response): Promise<void> {
    logger('params: %o', request.params)
    logger('body: %o', request.body)

    const currentSettings = this.settings()

    const {
      info: { name: relayName, relay_url: relayUrl },
    } = currentSettings

    const limited = await this.isRateLimited(request, currentSettings)
    if (limited) {
      response.status(429).setHeader('content-type', 'text/plain; charset=utf8').send('Too many requests')
      return
    }

    if (!request.body || typeof request.body !== 'object') {
      response.status(400).setHeader('content-type', 'text/plain; charset=utf8').send('Invalid request')

      return
    }

    const tosAccepted = request.body?.tosAccepted === 'yes'

    if (!tosAccepted) {
      response.status(400).setHeader('content-type', 'text/plain; charset=utf8').send('ToS agreement: not accepted')

      return
    }

    const isAdmissionInvoice = request.body?.feeSchedule === 'admission'
    if (!isAdmissionInvoice) {
      response.status(400).setHeader('content-type', 'text/plain; charset=utf8').send('Invalid fee')

      return
    }

    const pubkeyRaw = path(['body', 'pubkey'], request)

    let pubkey: string
    if (typeof pubkeyRaw !== 'string') {
      response.status(400).setHeader('content-type', 'text/plain; charset=utf8').send('Invalid pubkey: missing')

      return
    } else if (/^[0-9a-f]{64}$/.test(pubkeyRaw)) {
      pubkey = pubkeyRaw
    } else if (/^npub1/.test(pubkeyRaw)) {
      try {
        pubkey = fromBech32(pubkeyRaw)
      } catch (_error) {
        response.status(400).setHeader('content-type', 'text/plain; charset=utf8').send('Invalid pubkey: invalid npub')

        return
      }
    } else {
      response.status(400).setHeader('content-type', 'text/plain; charset=utf8').send('Invalid pubkey: unknown format')

      return
    }

    const isApplicableFee = (feeSchedule: FeeSchedule) =>
      feeSchedule.enabled && !feeSchedule.whitelists?.pubkeys?.includes(pubkey)
    const admissionFee = currentSettings.payments?.feeSchedules?.admission?.filter(isApplicableFee) ?? []

    if (!Array.isArray(admissionFee) || !admissionFee.length) {
      response.status(400).setHeader('content-type', 'text/plain; charset=utf8').send('No admission fee required')

      return
    }

    const minBalance = currentSettings.limits?.event?.pubkey?.minBalance
    const user = await this.userRepository.findByPubkey(pubkey)
    if (user && user.isAdmitted && (!minBalance || user.balance >= minBalance)) {
      response.status(400).setHeader('content-type', 'text/plain; charset=utf8').send('User is already admitted.')

      return
    }

    let invoice: Invoice
    const amount = admissionFee.reduce((sum, fee) => BigInt(fee.amount) + sum, 0n)

    try {
      const description = `${relayName} Admission Fee for ${toBech32('npub')(pubkey)}`

      invoice = await this.paymentsService.createInvoice(pubkey, amount, description)
    } catch (error) {
      logger.error('Unable to create invoice. Reason:', error)
      response
        .status(500)
        .setHeader('content-type', 'text/plain')
        .send('Unable to create invoice')
      return
    }

    const relayPrivkey = getRelayPrivateKey(relayUrl)
    const relayPubkey = getPublicKey(relayPrivkey)

    const expiresAt = invoice.expiresAt?.toISOString() ?? ''
    const pathPrefix = getPublicPathPrefix(request, currentSettings)

    const pageContent = getTemplate('./resources/post-invoice.html')
    const body = pageContent
      // HTML text / attribute contexts — values must be HTML-escaped
      .replaceAll('{{name}}', escapeHtml(relayName))
      .replaceAll('{{relay_url_html}}', escapeHtml(relayUrl))
      .replaceAll('{{invoice_html}}', escapeHtml(invoice.bolt11))
      .replaceAll('{{pubkey_html}}', escapeHtml(pubkey))
      .replaceAll('{{path_prefix}}', escapeHtml(pathPrefix))
      .replaceAll('{{amount}}', (amount / 1000n).toString())
      // JS contexts — safeJsonForScript serializes and escapes < to prevent </script> injection
      .replaceAll('{{reference_json}}', safeJsonForScript(invoice.id))
      .replaceAll('{{relay_url_json}}', safeJsonForScript(relayUrl))
      .replaceAll('{{relay_pubkey_json}}', safeJsonForScript(relayPubkey))
      .replaceAll('{{invoice_json}}', safeJsonForScript(invoice.bolt11))
      .replaceAll('{{pubkey_json}}', safeJsonForScript(pubkey))
      .replaceAll('{{expires_at_json}}', safeJsonForScript(expiresAt))
      .replaceAll('{{path_prefix_json}}', safeJsonForScript(pathPrefix))
      .replaceAll('{{processor_json}}', safeJsonForScript(currentSettings.payments.processor))
      // nonce is crypto-random base64 — safe in both attribute and script contexts
      .replaceAll('{{nonce}}', response.locals.nonce)

    response.status(200).setHeader('Content-Type', 'text/html; charset=utf8').send(body)

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
          logger('rate limited %s: %d in %d milliseconds', remoteAddress, rate, period)
          limited = true
        }
      }
    }
    return limited
  }
}
