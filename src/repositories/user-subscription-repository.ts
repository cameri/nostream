import { DatabaseClient, Pubkey } from '../@types/base'
import { IUserSubscriptionRepository } from '../@types/repositories'
import { DBUserSubscription, SubscriptionStatus, UserSubscription } from '../@types/user-subscription'
import { createLogger } from '../factories/logger-factory'
import { toBuffer } from '../utils/transform'
import { randomUUID } from 'crypto'

const logger = createLogger('user-subscription-repository')

function fromDBUserSubscription(row: DBUserSubscription): UserSubscription {
  return {
    id: row.id,
    pubkey: row.pubkey.toString('hex'),
    planId: row.plan_id,
    status: row.status,
    currentPeriodStart: row.current_period_start,
    currentPeriodEnd: row.current_period_end,
    graceUntil: row.grace_until,
    cancelAtPeriodEnd: row.cancel_at_period_end,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function toDBUserSubscription(subscription: UserSubscription): DBUserSubscription {
  return {
    id: subscription.id,
    pubkey: toBuffer(subscription.pubkey),
    plan_id: subscription.planId,
    status: subscription.status,
    current_period_start: subscription.currentPeriodStart,
    current_period_end: subscription.currentPeriodEnd,
    grace_until: subscription.graceUntil,
    cancel_at_period_end: subscription.cancelAtPeriodEnd,
    created_at: subscription.createdAt,
    updated_at: subscription.updatedAt,
  }
}

export class UserSubscriptionRepository implements IUserSubscriptionRepository {
  public constructor(private readonly dbClient: DatabaseClient) {}

  public async findByPubkey(
    pubkey: Pubkey,
    client: DatabaseClient = this.dbClient,
  ): Promise<UserSubscription | undefined> {
    logger('find subscription by pubkey')

    const [row] = await client<DBUserSubscription>('user_subscriptions')
      .where('pubkey', toBuffer(pubkey))
      .select()

    if (!row) {
      return
    }

    return fromDBUserSubscription(row)
  }

  public async upsert(
    subscription: UserSubscription,
    client: DatabaseClient = this.dbClient,
  ): Promise<UserSubscription> {
    logger('upsert subscription for %s', subscription.pubkey)

    const now = new Date()
    const row = {
      ...toDBUserSubscription({
        ...subscription,
        id: subscription.id || randomUUID(),
        updatedAt: now,
        createdAt: subscription.createdAt ?? now,
      }),
      updated_at: now,
    }

    await client<DBUserSubscription>('user_subscriptions')
      .insert(row)
      .onConflict('pubkey')
      .merge([
        'plan_id',
        'status',
        'current_period_start',
        'current_period_end',
        'grace_until',
        'cancel_at_period_end',
        'updated_at',
      ])

    const saved = await this.findByPubkey(subscription.pubkey, client)
    if (!saved) {
      throw new Error(`Unable to upsert subscription for ${subscription.pubkey}`)
    }

    return saved
  }

  public async findDueForRenewal(
    before: Date,
    limit: number = 100,
    client: DatabaseClient = this.dbClient,
  ): Promise<UserSubscription[]> {
    logger('find subscriptions due for renewal before %s (limit %d)', before.toISOString(), limit)

    const rows = await client<DBUserSubscription>('user_subscriptions')
      .whereIn('status', [SubscriptionStatus.ACTIVE, SubscriptionStatus.RENEWAL_PENDING])
      .where('current_period_end', '<=', before)
      .orderBy('current_period_end', 'asc')
      .limit(limit)
      .select()

    return rows.map(fromDBUserSubscription)
  }

  public async findExpired(
    asOf: Date,
    limit: number = 100,
    client: DatabaseClient = this.dbClient,
  ): Promise<UserSubscription[]> {
    logger('find expired subscriptions as of %s (limit %d)', asOf.toISOString(), limit)

    const rows = await client<DBUserSubscription>('user_subscriptions')
      .where(function () {
        this.where('status', SubscriptionStatus.PAST_DUE).where(function () {
          this.whereNull('grace_until').orWhere('grace_until', '<=', asOf)
        })
      })
      .orWhere(function () {
        this.whereIn('status', [SubscriptionStatus.ACTIVE, SubscriptionStatus.RENEWAL_PENDING]).where(
          'current_period_end',
          '<=',
          asOf,
        )
      })
      .orderBy('current_period_end', 'asc')
      .limit(limit)
      .select()

    return rows.map(fromDBUserSubscription)
  }
}
