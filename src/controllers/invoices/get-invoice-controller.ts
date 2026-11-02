import { escapeHtml, safeJsonForScript } from '../../utils/html'
import { path, pathEq } from 'ramda'
import { Request, Response } from 'express'

import { createSettings } from '../../factories/settings-factory'

import { FeeSchedule, Settings } from '../../@types/settings'
import { IController } from '../../@types/controllers'

import { areSubscriptionsEnabled, getSubscriptionPlans } from '../../utils/subscription'
import { getTemplate } from '../../utils/template-cache'
import { getPublicPathPrefix } from '../../utils/http'

const ADMISSION_DESCRIPTION =
  'This <a href="https://github.com/nostr-protocol/nostr">Nostr</a> relay <strong>requires</strong> a one-time admission fee. <br /> Once payment is complete, you will be able to post and fetch events from this relay.'

const SUBSCRIPTION_DESCRIPTION =
  'This <a href="https://github.com/nostr-protocol/nostr">Nostr</a> relay <strong>requires</strong> a subscription. <br /> Choose a plan. Once payment is complete, you will be able to post and fetch events from this relay until the period ends.'

const SECONDS_PER_DAY = 86400

const renderPlanFields = (settings: Settings): string => {
  const options = getSubscriptionPlans(settings)
    .map((plan, index) => {
      const days = plan.intervalSeconds / SECONDS_PER_DAY
      const period = Number.isInteger(days) ? `${days} day${days === 1 ? '' : 's'}` : `${plan.intervalSeconds} seconds`
      const label = `${plan.id}: ${(BigInt(plan.amount) / 1000n).toString()} sats per ${period}`
      const id = `plan-${index}`

      return `<div class="form-check"><input class="form-check-input" type="radio" name="planId" id="${id}" value="${escapeHtml(plan.id)}"${index === 0 ? ' checked' : ''} required><label class="form-check-label" for="${id}">${escapeHtml(label)}${plan.description ? ` - ${escapeHtml(plan.description)}` : ''}</label></div>`
    })
    .join('')

  return `<div class="d-flex flex-column mb-4"><span class="h5">Plan</span>${options}</div>`
}

export class GetInvoiceController implements IController {
  public async handleRequest(req: Request, res: Response): Promise<void> {
    const settings = createSettings()

    const subscriptionsEnabled = areSubscriptionsEnabled(settings)
    if (
      pathEq(['payments', 'enabled'], true, settings) &&
      (subscriptionsEnabled || pathEq(['payments', 'feeSchedules', 'admission', '0', 'enabled'], true, settings))
    ) {
      const name = path<string>(['info', 'name'])(settings)
      const feeSchedule = path<FeeSchedule>(['payments', 'feeSchedules', 'admission', '0'], settings)
      const page = getTemplate('./resources/get-invoice.html')
        .replaceAll('{{name}}', escapeHtml(name))
        .replaceAll('{{path_prefix}}', escapeHtml(getPublicPathPrefix(req, settings)))
        .replaceAll('{{processor_json}}', safeJsonForScript(settings.payments.processor))
        .replaceAll('{{fee_description_html}}', subscriptionsEnabled ? SUBSCRIPTION_DESCRIPTION : ADMISSION_DESCRIPTION)
        .replaceAll('{{plan_fields_html}}', subscriptionsEnabled ? renderPlanFields(settings) : '')
        .replaceAll(
          '{{pay_label}}',
          subscriptionsEnabled ? 'Pay' : `Pay ${(BigInt(feeSchedule.amount) / 1000n).toString()} sats`,
        )
        .replaceAll('{{nonce}}', res.locals.nonce)

      res.status(200).setHeader('content-type', 'text/html; charset=utf8').send(page)
    } else {
      res.status(404).send()
    }
  }
}
