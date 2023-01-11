import { NextFunction, Request, Response } from 'express'
import { readFileSync } from 'fs'

import { getPrivateKeyFromSecret, getPublicKey } from '../../utils/event'
import { createLogger } from '../../factories/logger-factory'
import { fromNpub } from '../../utils/transform'
import { getRemoteAddress } from '../../utils/http'
import { IPaymentsProcessor } from '../../@types/clients'
import { createSettings as settings } from '../../factories/settings-factory'
import { slidingWindowRateLimiterFactory } from '../../factories/rate-limiter-factory'

let pageCache: string

const debug = createLogger('post-invoice-request-handler')

// deepcode ignore NoRateLimitingForExpensiveWebOperation: only read once
export const postInvoiceRequestHandler = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  if (!pageCache) {
    pageCache = readFileSync('./resources/invoices.html', 'utf8')
  }

  debug('params: %o', req.params)
  debug('body: %o', req.body)

  const currentSettings = settings()

  const {
    info: { name, relay_url },
    limits: { invoice: { ipWhitelist, rateLimits } },
  } = currentSettings

  const remoteAddress = getRemoteAddress(req, currentSettings)

  const isRateLimited = async (remoteAddress: string) => {
    let limited = false
    if (!ipWhitelist.includes(remoteAddress)) {
      const rateLimiter = slidingWindowRateLimiterFactory()
      for (const { rate, period } of rateLimits) {
        if (await rateLimiter.hit(`${remoteAddress}:invoice:${period}`, 1, { period, rate })) {
          debug('rate limited %s: %d in %d milliseconds', remoteAddress, rate, period)
          limited = true
        }
      }
    }
    return limited
  }

  const limited = await isRateLimited(remoteAddress)
  if (limited) {
    res
      .status(429)
      .setHeader('content-type', 'text/plain; charset=utf8')
      .send('Too many requests')
    return next()
  }

  const tosAccepted = req.body?.tosAccepted === 'yes'

  if (!tosAccepted) {
    res
      .status(400)
      .setHeader('content-type', 'text/plain; charset=utf8')
      .send('ToS agreement: not accepted')

    return next()
  }

  const pubkeyRaw = typeof req.body?.pubkey === 'string'
    ? req.body?.pubkey?.trim()
    : undefined

  let pubkey: string
  if (typeof pubkeyRaw !== 'string') {
    res
      .status(400)
      .setHeader('content-type', 'text/plain; charset=utf8')
      .send('Invalid pubkey: missing')

    return next()
  } else if (/^[0-9a-f]{64}$/.test(pubkeyRaw)) {
    pubkey = pubkeyRaw
  } else if (/^npub/.test(pubkeyRaw)) {
    try {
      pubkey = fromNpub(pubkeyRaw)
    } catch (error) {
      res
        .status(400)
        .setHeader('content-type', 'text/plain; charset=utf8')
        .send('Invalid pubkey: npub not valid')

    return next()
    }
  } else {
    res
      .status(400)
      .setHeader('content-type', 'text/plain; charset=utf8')
      .send('Invalid pubkey: unknown format')

    return next()
  }

  const admissionFee = currentSettings.payments?.feeSchedules.admission
    .filter((feeSchedule) => feeSchedule.enabled && !feeSchedule.whitelists.pubkeys.includes(pubkey))

  if (!Array.isArray(admissionFee) || !admissionFee.length) {
    res
      .status(400)
      .setHeader('content-type', 'text/plain; charset=utf8')
      .send('No admission fee required')

    return next()
  }

  const paymentsProcessor = req['paymentsProcessor'] as IPaymentsProcessor

  const invoiceResponse = await paymentsProcessor.createInvoice({
    amountMsats: admissionFee.reduce((sum, fee) => sum + fee.amount, 0),
    description: `Admission Fee for ${pubkey}`,
    requestId: pubkey,
  })

  const privkey = getPrivateKeyFromSecret(process.env.SECRET)(pubkey)
  const relayPubkey = getPublicKey(privkey)

  const replacements = {
    name,
    pubkey,
    relay_url,
    relay_pubkey: relayPubkey,
    invoice: invoiceResponse.invoice.bolt11,
  }

  const body = Object
    .entries(replacements)
    .reduce((body, [key, value]) => body.replaceAll(`{{${key}}}`, value), pageCache)

  res
    .status(200)
    .setHeader('Content-Type', 'text/html; charset=utf8')
    .send(body)

  return next()
}
