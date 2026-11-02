import { IPaymentsService, ISubscriptionService } from '../@types/services'
import { Settings } from '../@types/settings'
import { SubscriptionStatus, UserSubscription } from '../@types/user-subscription'
import { IUserSubscriptionRepository } from '../@types/repositories'
import { areSubscriptionsEnabled, endPeriod, findSubscriptionPlan, RENEWAL_LEAD_SECONDS } from '../utils/subscription'
import { createLogger } from '../factories/logger-factory'
import { toBech32 } from '../utils/transform'

const logger = createLogger('subscription-service')

/** Subscriptions per query, and how many queries one pass makes before leaving the rest to the next. */
const SWEEP_PAGE_SIZE = 10
const SWEEP_MAX_PAGES = 10

type Sweep = 'ended' | 'grace' | 'renewal'

export class SubscriptionService implements ISubscriptionService {
  /**
   * Where each sweep starts. Rows a pass could not handle stay at the front of its query, so the next
   * pass starts behind them. Without this, more unhandled rows than one pass reads would hide every
   * row after them. It starts over from the front once a pass reaches the end of the rows.
   */
  private readonly cursors: Record<Sweep, number> = { ended: 0, grace: 0, renewal: 0 }

  public constructor(
    private readonly userSubscriptionRepository: IUserSubscriptionRepository,
    private readonly paymentsService: IPaymentsService,
    private readonly settings: () => Settings,
  ) {}

  public async processLifecycle(now = new Date()): Promise<number> {
    const currentSettings = this.settings()
    if (!areSubscriptionsEnabled(currentSettings)) {
      return 0
    }

    // Ends first, so a subscription that lapsed is not also sent a renewal invoice.
    const changed =
      (await this.sweep(
        'ended',
        (limit, offset) => this.userSubscriptionRepository.findPeriodEnded(now, limit, offset),
        (subscription) => this.endPeriod(subscription, currentSettings, now),
      )) +
      (await this.sweep(
        'grace',
        (limit, offset) => this.userSubscriptionRepository.findGraceEnded(now, limit, offset),
        (subscription) => this.expire(subscription),
      )) +
      (await this.sweep(
        'renewal',
        (limit, offset) =>
          this.userSubscriptionRepository.findDueForRenewal(
            new Date(now.getTime() + RENEWAL_LEAD_SECONDS * 1000),
            limit,
            offset,
          ),
        (subscription) => this.requestRenewal(subscription, currentSettings),
      ))

    return changed
  }

  /**
   * Each handled subscription leaves the query that found it, so the next page starts where the
   * unhandled ones end: skipping them with an offset keeps a subscription that cannot be handled,
   * such as one on a plan the operator removed, from blocking the ones behind it. The work of one
   * pass is bounded, and the next one carries on behind the rows this one skipped.
   */
  private async sweep(
    sweep: Sweep,
    find: (limit: number, offset: number) => Promise<UserSubscription[]>,
    handle: (subscription: UserSubscription) => Promise<boolean>,
  ): Promise<number> {
    let changed = 0
    let skipped = this.cursors[sweep]
    let reachedEnd = false

    for (let page = 0; page < SWEEP_MAX_PAGES; page++) {
      const subscriptions = await find(SWEEP_PAGE_SIZE, skipped)

      for (const subscription of subscriptions) {
        let handled = false
        try {
          handled = await handle(subscription)
        } catch (error) {
          logger.error('Unable to process subscription for %s. Reason:', subscription.pubkey, error)
        }

        if (handled) {
          changed++
        } else {
          skipped++
        }
      }

      if (subscriptions.length < SWEEP_PAGE_SIZE) {
        reachedEnd = true
        break
      }
    }

    this.cursors[sweep] = reachedEnd ? 0 : skipped

    return changed
  }

  private async requestRenewal(subscription: UserSubscription, settings: Settings): Promise<boolean> {
    const plan = findSubscriptionPlan(settings, subscription.planId)
    if (!plan) {
      logger('plan %s of %s is no longer configured, not renewing', subscription.planId, subscription.pubkey)
      return false
    }

    const description = `${settings.info.name} ${plan.id} subscription renewal for ${toBech32('npub')(subscription.pubkey)}`
    const invoice = await this.paymentsService.createInvoice(
      subscription.pubkey,
      BigInt(plan.amount),
      description,
      plan.id,
    )

    // The subscriber is told about the invoice either way: it can be paid whatever the status says.
    await this.paymentsService.sendRenewalNotification(invoice)

    if (subscription.status === SubscriptionStatus.ACTIVE) {
      return this.userSubscriptionRepository.updateIfCurrent(subscription, {
        status: SubscriptionStatus.RENEWAL_PENDING,
      })
    }

    return true
  }

  private async endPeriod(subscription: UserSubscription, settings: Settings, now: Date): Promise<boolean> {
    const plan = findSubscriptionPlan(settings, subscription.planId)
    if (!plan) {
      logger('plan %s of %s is no longer configured, not ending its period', subscription.planId, subscription.pubkey)
      return false
    }

    return this.userSubscriptionRepository.updateIfCurrent(subscription, endPeriod(subscription, plan, now))
  }

  private async expire(subscription: UserSubscription): Promise<boolean> {
    return this.userSubscriptionRepository.updateIfCurrent(subscription, {
      status: SubscriptionStatus.EXPIRED,
      graceEndsAt: null,
    })
  }
}
