import { Pubkey } from '../@types/base'
import { IUserSubscriptionRepository } from '../@types/repositories'
import { IPaymentsService, ISubscriptionService } from '../@types/services'
import { Settings } from '../@types/settings'
import { SubscriptionStatus, UserSubscription } from '../@types/user-subscription'
import { createLogger } from '../factories/logger-factory'
import { areSubscriptionsEnabled, endPeriod, findSubscriptionPlan, RENEWAL_LEAD_SECONDS } from '../utils/subscription'
import { toBech32 } from '../utils/transform'

const logger = createLogger('subscription-service')

/** Subscriptions per query, and how many queries one pass makes before leaving the rest to the next. */
const SWEEP_PAGE_SIZE = 10
const SWEEP_MAX_PAGES = 10

export class SubscriptionService implements ISubscriptionService {
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
        (limit) => this.userSubscriptionRepository.findPeriodEnded(now, limit),
        (subscription) => this.endPeriod(subscription, currentSettings, now),
      )) +
      (await this.sweep(
        (limit) => this.userSubscriptionRepository.findGraceEnded(now, limit),
        (subscription) => this.expire(subscription),
      )) +
      (await this.sweep(
        (limit) =>
          this.userSubscriptionRepository.findDueForRenewal(
            new Date(now.getTime() + RENEWAL_LEAD_SECONDS * 1000),
            limit,
          ),
        (subscription) => this.requestRenewal(subscription, currentSettings),
      ))

    return changed
  }

  public async cancel(pubkey: Pubkey): Promise<boolean> {
    const subscription = await this.userSubscriptionRepository.findByPubkey(pubkey)
    if (!subscription || subscription.status === SubscriptionStatus.EXPIRED || !subscription.currentPeriodEnd) {
      return false
    }

    await this.userSubscriptionRepository.upsert({ ...subscription, cancelAtPeriodEnd: true })

    return true
  }

  /**
   * Each handled subscription leaves the query that found it, so asking again moves on.
   * One that cannot be handled would come back every time, so a pass stops as soon as
   * a page makes no progress.
   */
  private async sweep(
    find: (limit: number) => Promise<UserSubscription[]>,
    handle: (subscription: UserSubscription) => Promise<boolean>,
  ): Promise<number> {
    let changed = 0

    for (let page = 0; page < SWEEP_MAX_PAGES; page++) {
      const subscriptions = await find(SWEEP_PAGE_SIZE)

      let handled = 0
      for (const subscription of subscriptions) {
        try {
          if (await handle(subscription)) {
            handled++
          }
        } catch (error) {
          logger.error('Unable to process subscription for %s. Reason:', subscription.pubkey, error)
        }
      }

      changed += handled
      if (!handled || subscriptions.length < SWEEP_PAGE_SIZE) {
        break
      }
    }

    return changed
  }

  private async requestRenewal(subscription: UserSubscription, settings: Settings): Promise<boolean> {
    const plan = findSubscriptionPlan(settings, subscription.planId)
    if (!plan) {
      logger('plan %s of %s is no longer configured, not renewing', subscription.planId, subscription.pubkey)
      return false
    }

    const description = `${settings.info.name} ${plan.id} subscription renewal for ${toBech32('npub')(subscription.pubkey)}`
    await this.paymentsService.createInvoice(subscription.pubkey, BigInt(plan.amount), description, plan.id)
    await this.userSubscriptionRepository.upsert({ ...subscription, status: SubscriptionStatus.RENEWAL_PENDING })

    return true
  }

  private async endPeriod(subscription: UserSubscription, settings: Settings, now: Date): Promise<boolean> {
    const plan = findSubscriptionPlan(settings, subscription.planId)
    if (!plan) {
      logger('plan %s of %s is no longer configured, not ending its period', subscription.planId, subscription.pubkey)
      return false
    }

    await this.userSubscriptionRepository.upsert({ ...subscription, ...endPeriod(subscription, plan, now) })

    return true
  }

  private async expire(subscription: UserSubscription): Promise<boolean> {
    await this.userSubscriptionRepository.upsert({
      ...subscription,
      status: SubscriptionStatus.EXPIRED,
      graceEndsAt: null,
    })

    return true
  }
}
