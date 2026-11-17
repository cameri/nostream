import { DatabaseClient } from '../@types/base'
import {
  DBPeeringInvoice,
  PeeringInvoice,
  PeeringInvoiceReason,
  PeeringInvoiceStatus,
} from '../@types/peering'
import { IPeeringInvoiceRepository } from '../@types/repositories'
import { createLogger } from '../factories/logger-factory'
import { fromBuffer, toBuffer } from '../utils/transform'

const logger = createLogger('peering-invoice-repository')

const toRow = (invoice: PeeringInvoice): DBPeeringInvoice => ({
  payment_hash: invoice.paymentHash,
  event_id: invoice.eventId,
  peer_pubkey: toBuffer(invoice.peerPubkey),
  bolt11: invoice.bolt11,
  amount_msats: invoice.amountMsats.toString(),
  status: invoice.status,
  reason: invoice.reason ?? null,
  auto_paid: invoice.autoPaid,
  budget_period_start: invoice.budgetPeriodStart ?? null,
  budget_period_end: invoice.budgetPeriodEnd ?? null,
  term_period_seconds: invoice.termPeriodSeconds ?? null,
  expires_at: invoice.expiresAt ?? null,
  seen_count: invoice.seenCount,
  paid_at: invoice.paidAt ?? null,
  created_at: invoice.createdAt,
  updated_at: invoice.updatedAt,
})

const fromRow = (row: DBPeeringInvoice): PeeringInvoice => ({
  paymentHash: row.payment_hash,
  eventId: row.event_id,
  peerPubkey: Buffer.isBuffer(row.peer_pubkey) ? fromBuffer(row.peer_pubkey) : String(row.peer_pubkey),
  bolt11: row.bolt11,
  amountMsats: BigInt(row.amount_msats),
  status: row.status,
  reason: (row.reason as PeeringInvoiceReason | null) ?? null,
  autoPaid: Boolean(row.auto_paid),
  budgetPeriodStart: row.budget_period_start,
  budgetPeriodEnd: row.budget_period_end,
  termPeriodSeconds: row.term_period_seconds,
  expiresAt: row.expires_at,
  seenCount: row.seen_count,
  paidAt: row.paid_at,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
})

const firstRow = (result: any): any => (Array.isArray(result) ? result[0] : result?.rows?.[0])

export class PeeringInvoiceRepository implements IPeeringInvoiceRepository {
  public constructor(private readonly dbClient: DatabaseClient) {}

  public async findByHash(
    paymentHash: string,
    client: DatabaseClient = this.dbClient,
  ): Promise<PeeringInvoice | undefined> {
    const row = await client<DBPeeringInvoice>('peering_invoices').where({ payment_hash: paymentHash }).first()

    return row ? fromRow(row) : undefined
  }

  public async insertIfNew(
    invoice: PeeringInvoice,
    client: DatabaseClient = this.dbClient,
  ): Promise<{ inserted: boolean; invoice: PeeringInvoice }> {
    const rows = await client<DBPeeringInvoice>('peering_invoices')
      .insert(toRow(invoice))
      .onConflict('payment_hash')
      .ignore()
      .returning('*')

    if (rows.length > 0) {
      return { inserted: true, invoice: fromRow(rows[0]) }
    }

    const existing = await this.findByHash(invoice.paymentHash, client)
    if (!existing) {
      throw new Error(`Unable to load peering invoice ${invoice.paymentHash}`)
    }

    const now = new Date()
    await client<DBPeeringInvoice>('peering_invoices')
      .where({ payment_hash: invoice.paymentHash })
      .update({
        seen_count: client.raw('seen_count + 1'),
        updated_at: now,
      })

    return { inserted: false, invoice: { ...existing, seenCount: existing.seenCount + 1, updatedAt: now } }
  }

  public async update(
    paymentHash: string,
    changes: Partial<
      Pick<
        PeeringInvoice,
        | 'status'
        | 'reason'
        | 'autoPaid'
        | 'paidAt'
        | 'budgetPeriodStart'
        | 'budgetPeriodEnd'
        | 'termPeriodSeconds'
      >
    >,
    client: DatabaseClient = this.dbClient,
  ): Promise<PeeringInvoice | undefined> {
    const patch: Record<string, unknown> = { updated_at: new Date() }
    if (changes.status !== undefined) {
      patch.status = changes.status
    }
    if (changes.reason !== undefined) {
      patch.reason = changes.reason
    }
    if (changes.autoPaid !== undefined) {
      patch.auto_paid = changes.autoPaid
    }
    if (changes.paidAt !== undefined) {
      patch.paid_at = changes.paidAt
    }
    if (changes.budgetPeriodStart !== undefined) {
      patch.budget_period_start = changes.budgetPeriodStart
    }
    if (changes.budgetPeriodEnd !== undefined) {
      patch.budget_period_end = changes.budgetPeriodEnd
    }
    if (changes.termPeriodSeconds !== undefined) {
      patch.term_period_seconds = changes.termPeriodSeconds
    }

    const rows = await client<DBPeeringInvoice>('peering_invoices')
      .where({ payment_hash: paymentHash })
      .update(patch)
      .returning('*')

    return rows.length > 0 ? fromRow(rows[0]) : undefined
  }

  public async claim(
    paymentHash: string,
    from: PeeringInvoiceStatus[],
    to: PeeringInvoiceStatus,
    client: DatabaseClient = this.dbClient,
  ): Promise<PeeringInvoice | undefined> {
    const rows = await client<DBPeeringInvoice>('peering_invoices')
      .where({ payment_hash: paymentHash })
      .whereIn('status', from)
      .update({ status: to, updated_at: new Date() })
      .returning('*')

    return rows.length > 0 ? fromRow(rows[0]) : undefined
  }

  public async list(statuses?: PeeringInvoiceStatus[], limit = 100): Promise<PeeringInvoice[]> {
    const query = this.dbClient<DBPeeringInvoice>('peering_invoices').orderBy('created_at', 'desc').limit(limit)
    if (statuses?.length) {
      query.whereIn('status', statuses)
    }

    const rows = await query
    return rows.map(fromRow)
  }

  public async reserveBudget(
    scope: string,
    periodStart: Date,
    periodEnd: Date,
    amountMsats: bigint,
    limitMsats: bigint,
    client: DatabaseClient,
  ): Promise<bigint | undefined> {
    const result = await client.raw(
      `INSERT INTO peering_budgets (scope, period_start, period_end, spent_msats)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (scope, period_start) DO UPDATE
       SET spent_msats = peering_budgets.spent_msats + EXCLUDED.spent_msats,
           period_end = EXCLUDED.period_end
       WHERE peering_budgets.spent_msats + EXCLUDED.spent_msats <= ?
       RETURNING spent_msats`,
      [scope, periodStart, periodEnd, amountMsats.toString(), limitMsats.toString()],
    )
    const row = firstRow(result)
    if (!row) {
      logger('budget %s exhausted for period %s', scope, periodStart.toISOString())
      return undefined
    }

    return BigInt(row.spent_msats)
  }

  public async addBudgetSpend(
    scope: string,
    periodStart: Date,
    periodEnd: Date,
    amountMsats: bigint,
    client: DatabaseClient,
  ): Promise<bigint> {
    const result = await client.raw(
      `INSERT INTO peering_budgets (scope, period_start, period_end, spent_msats)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (scope, period_start) DO UPDATE
       SET spent_msats = peering_budgets.spent_msats + EXCLUDED.spent_msats,
           period_end = EXCLUDED.period_end
       RETURNING spent_msats`,
      [scope, periodStart, periodEnd, amountMsats.toString()],
    )

    return BigInt(firstRow(result).spent_msats)
  }

  public async releaseBudget(
    scope: string,
    periodStart: Date,
    amountMsats: bigint,
    client: DatabaseClient,
  ): Promise<void> {
    await client.raw(
      `UPDATE peering_budgets
       SET spent_msats = GREATEST(spent_msats - ?, 0)
       WHERE scope = ? AND period_start = ?`,
      [amountMsats.toString(), scope, periodStart],
    )
  }
}
