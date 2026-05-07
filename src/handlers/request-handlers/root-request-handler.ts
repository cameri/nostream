import { NextFunction, Request, Response } from 'express'
import { path, pathEq } from 'ramda'
import { createSettings } from '../../factories/settings-factory'
import { escapeHtml } from '../../utils/html'
import { FeeSchedule } from '../../@types/settings'
import { DEFAULT_FILTER_LIMIT } from '../../constants/base'
import { fromBech32 } from '../../utils/transform'
import { getTemplate } from '../../utils/template-cache'
import { getPublicPathPrefix, joinPathPrefix } from '../../utils/http'
import packageJson from '../../../package.json'

export const hasExplicitNostrJsonAcceptHeader = (request: Request): boolean => {
  const acceptHeader = request.headers.accept

  if (!acceptHeader) {
    return false
  }

  const acceptHeaderValue = Array.isArray(acceptHeader) ? acceptHeader.join(',') : acceptHeader

  return acceptHeaderValue.split(',').some((token) => {
    const [mediaType, ...params] = token
      .split(';')
      .map((value) => value.trim().toLowerCase())

    if (mediaType !== 'application/nostr+json') {
      return false
    }

    const quality = params.find((param) => param.startsWith('q='))

    if (!quality) {
      return true
    }

    const qValue = Number.parseFloat(quality.slice(2))

    return !Number.isNaN(qValue) && qValue > 0
  })
}

export const rootRequestHandler = (request: Request, response: Response, next: NextFunction) => {
  const settings = createSettings()
  const pathPrefix = getPublicPathPrefix(request, settings)

  if (hasExplicitNostrJsonAcceptHeader(request)) {
    const {
      info: { name, description, banner, icon, pubkey: rawPubkey, self: rawSelf, contact, relay_url, terms_of_service },
    } = settings

    const paymentsUrl = new URL(relay_url)
    paymentsUrl.protocol = paymentsUrl.protocol === 'wss:' ? 'https:' : 'http:'
    paymentsUrl.pathname = joinPathPrefix(pathPrefix, '/invoices')

    const content = settings.limits?.event?.content
    const eventLimits = settings.limits?.event
    const createdAtLimits = eventLimits?.createdAt
    const hasAdmissionRestriction =
      settings.payments?.enabled === true &&
      Boolean(settings.payments?.feeSchedules?.admission?.some((feeSchedule) => feeSchedule.enabled))
    const hasWriteRestriction =
      hasAdmissionRestriction ||
      (eventLimits?.eventId?.minLeadingZeroBits ?? 0) > 0 ||
      (eventLimits?.pubkey?.minLeadingZeroBits ?? 0) > 0 ||
      (eventLimits?.pubkey?.whitelist?.length ?? 0) > 0 ||
      (eventLimits?.pubkey?.blacklist?.length ?? 0) > 0 ||
      (eventLimits?.kind?.whitelist?.length ?? 0) > 0 ||
      (eventLimits?.kind?.blacklist?.length ?? 0) > 0

    const pubkey = rawPubkey.startsWith('npub1') ? fromBech32(rawPubkey) : rawPubkey
    const self = rawSelf?.startsWith('npub1') ? fromBech32(rawSelf) : rawSelf

    const relayInformationDocument = {
      name,
      description,
      ...(banner !== undefined ? { banner } : {}),
      ...(icon !== undefined ? { icon } : {}),
      pubkey,
      ...(self !== undefined ? { self } : {}),
      contact,
      supported_nips: packageJson.supportedNips,
      supported_nip_extensions: packageJson.supportedNipExtensions,
      supported_mips: packageJson.supportedMips,
      software: packageJson.repository.url,
      version: packageJson.version,
      ...(terms_of_service !== undefined ? { terms_of_service } : {}),
      limitation: {
        max_message_length: settings.network.maxPayloadSize,
        max_subscriptions: settings.limits?.client?.subscription?.maxSubscriptions,
        max_filters: settings.limits?.client?.subscription?.maxFilters,
        max_limit: settings.limits?.client?.subscription?.maxLimit,
        max_subid_length: settings.limits?.client?.subscription?.maxSubscriptionIdLength,
        min_prefix: settings.limits?.client?.subscription?.minPrefixLength,
        max_event_tags: 2500,
        max_content_length: Array.isArray(content)
          ? content[0].maxLength // best guess since we have per-kind limits
          : content?.maxLength,
        min_pow_difficulty: eventLimits?.eventId?.minLeadingZeroBits,
        auth_required: false,
        payment_required: settings.payments?.enabled,
        created_at_lower_limit: createdAtLimits?.maxNegativeDelta,
        created_at_upper_limit: createdAtLimits?.maxPositiveDelta,
        default_limit: DEFAULT_FILTER_LIMIT,
        restricted_writes: hasWriteRestriction,
      },
      payments_url: paymentsUrl.toString(),
      fees: Object.getOwnPropertyNames(settings.payments.feeSchedules).reduce(
        (prev, feeName) => {
          const feeSchedules = settings.payments.feeSchedules[feeName] as FeeSchedule[]

          return {
            ...prev,
            [feeName]: feeSchedules.reduce(
              (fees, fee) => (fee.enabled ? [...fees, { amount: fee.amount, unit: 'msats' }] : fees),
              [],
            ),
          }
        },
        {} as Record<string, { amount: number; unit: string }>,
      ),
    }

    response
      .setHeader('content-type', 'application/nostr+json')
      .setHeader('access-control-allow-origin', '*')
      .setHeader('access-control-allow-headers', '*')
      .setHeader('access-control-allow-methods', 'GET, OPTIONS')
      .status(200)
      .send(relayInformationDocument)

    return
  }

  const admissionFeeEnabled =
    pathEq(['payments', 'enabled'], true, settings) &&
    pathEq(['payments', 'feeSchedules', 'admission', '0', 'enabled'], true, settings)
  const admissionFee = path<FeeSchedule>(['payments', 'feeSchedules', 'admission', '0'], settings)
  const amount = admissionFeeEnabled && admissionFee ? (BigInt(admissionFee.amount) / 1000n).toString() : '0'

  let page: string
  try {
    page = getTemplate('./resources/index.html')
      .replaceAll('{{name}}', escapeHtml(settings.info.name))
      .replaceAll('{{description}}', escapeHtml(settings.info.description ?? ''))
      .replaceAll('{{relay_url}}', escapeHtml(settings.info.relay_url))
      .replaceAll('{{amount}}', amount)
      .replaceAll('{{path_prefix}}', escapeHtml(pathPrefix))
      .replaceAll('{{payments_section_class}}', admissionFeeEnabled ? '' : 'd-none')
      .replaceAll('{{no_payments_section_class}}', admissionFeeEnabled ? 'd-none' : '')
      .replaceAll('{{nonce}}', response.locals.nonce)
  } catch (err) {
    next(err)
    return
  }

  response.status(200).setHeader('content-type', 'text/html; charset=utf8').send(page)
}
