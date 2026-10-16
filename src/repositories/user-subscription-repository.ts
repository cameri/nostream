import { DatabaseClient, Pubkey } from '../@types/base'
import { DBUserSubscription, SubscriptionStatus, UserSubscription } from '../@types/user-subscription'
import { fromBuffer, toBuffer } from '../utils/transform'
import { createLogger } from '../factories/logger-factory'
import { IUserSubscriptionRepository } from '../@types/repositories'

const logger = createLogger('user-subscription-repository')

const DEFAULT_PAGE_SIZE = 10

const fromDBUserSubscription = (row: DBUserSubscription): UserSubscription => ({
  pubkey: fromBuffer(row.pubkey),
  planId: row.plan_id,
  status: row.status,
  currentPeriodStart: row.current_period_start,
  currentPeriodEnd: row.current_period_end,
  graceEndsAt: row.grace_ends_at,
  cancelAtPeriodEnd: row.cancel_at_period_end,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
})

export class UserSubscriptionRepository implements IUserSubscriptionRepository {
  public constructor(private readonly dbClient: DatabaseClient) {}

  public async findByPubkey(
    pubkey: Pubkey,
    client: DatabaseClient = this.dbClient,
  ): Promise<UserSubscription | undefined> {
    const [row] = await client<DBUserSubscription>('user_subscriptions').where('pubkey', toBuffer(pubkey)).select()

    return row ? fromDBUserSubscription(row) : undefined
  }

  public async upsert(
    subscription: Omit<UserSubscription, 'createdAt' | 'updatedAt'>,
    client: DatabaseClient = this.dbClient,
  ): Promise<number> {
    logger('upserting subscription for %s: %s', subscription.pubkey, subscription.planId)

    const now = new Date()
    const row: DBUserSubscription = {
      pubkey: toBuffer(subscription.pubkey),
      plan_id: subscription.planId,
      status: subscription.status,
      current_period_start: subscription.currentPeriodStart,
      current_period_end: subscription.currentPeriodEnd,
      grace_ends_at: subscription.graceEndsAt,
      cancel_at_period_end: subscription.cancelAtPeriodEnd,
      created_at: now,
      updated_at: now,
    }

    const result = await client<DBUserSubscription>('user_subscriptions')
      .insert(row)
      .onConflict('pubkey')
      .merge([
        'plan_id',
        'status',
        'current_period_start',
        'current_period_end',
        'grace_ends_at',
        'cancel_at_period_end',
        'updated_at',
      ])

    return (result as unknown as { rowCount?: number }).rowCount ?? 0
  }

  public async findDueForRenewal(
    before: Date,
    limit = DEFAULT_PAGE_SIZE,
    client: DatabaseClient = this.dbClient,
  ): Promise<UserSubscription[]> {
    const rows = await client<DBUserSubscription>('user_subscriptions')
      .where('status', SubscriptionStatus.ACTIVE)
      .where('cancel_at_period_end', false)
      .whereNotNull('current_period_end')
      .where('current_period_end', '<=', before)
      .orderBy('current_period_end', 'asc')
      .limit(limit)
      .select()

    return rows.map(fromDBUserSubscription)
  }

  public async findPeriodEnded(
    now: Date,
    limit = DEFAULT_PAGE_SIZE,
    client: DatabaseClient = this.dbClient,
  ): Promise<UserSubscription[]> {
    const rows = await client<DBUserSubscription>('user_subscriptions')
      .whereIn('status', [SubscriptionStatus.ACTIVE, SubscriptionStatus.RENEWAL_PENDING])
      .whereNotNull('current_period_end')
      .where('current_period_end', '<=', now)
      .orderBy('current_period_end', 'asc')
      .limit(limit)
      .select()

    return rows.map(fromDBUserSubscription)
  }

  public async findGraceEnded(
    now: Date,
    limit = DEFAULT_PAGE_SIZE,
    client: DatabaseClient = this.dbClient,
  ): Promise<UserSubscription[]> {
    const rows = await client<DBUserSubscription>('user_subscriptions')
      .where('status', SubscriptionStatus.PAST_DUE)
      .whereNotNull('grace_ends_at')
      .where('grace_ends_at', '<=', now)
      .orderBy('grace_ends_at', 'asc')
      .limit(limit)
      .select()

    return rows.map(fromDBUserSubscription)
  }
}
