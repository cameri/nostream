import { DatabaseClient, Pubkey } from '../@types/base'
import { DBPeeringPayment, PeeringPayment, PeeringPaymentDirection, PeeringPaymentStatus } from '../@types/peering'
import { IPeeringPaymentRepository } from '../@types/repositories'
import { createLogger } from '../factories/logger-factory'
import { fromDBPeeringPayment, toBuffer } from '../utils/transform'

const logger = createLogger('peering-payment-repository')

const toRow = (payment: PeeringPayment): Omit<DBPeeringPayment, 'created_at' | 'updated_at'> => ({
  peer_pubkey: toBuffer(payment.peerPubkey),
  direction: payment.direction,
  status: payment.status,
  current_invoice_id: payment.currentInvoiceId ?? null,
  renewal_invoice_id: payment.renewalInvoiceId ?? null,
  period_start: payment.periodStart ?? null,
  period_end: payment.periodEnd ?? null,
  term_amount_msats:
    typeof payment.termAmountMsats === 'bigint' && payment.termAmountMsats >= 0n
      ? payment.termAmountMsats.toString()
      : null,
  term_period_seconds: payment.termPeriodSeconds ?? null,
  last_settled_invoice_id: payment.lastSettledInvoiceId ?? null,
  last_settled_at: payment.lastSettledAt ?? null,
  last_checked_at: payment.lastCheckedAt ?? null,
  last_error: payment.lastError ?? null,
})

export class PeeringPaymentRepository implements IPeeringPaymentRepository {
  public constructor(private readonly dbClient: DatabaseClient) {}

  public async findByPeer(pubkey: Pubkey, client: DatabaseClient = this.dbClient): Promise<PeeringPayment | undefined> {
    const row = await client<DBPeeringPayment>('peering_payments')
      .where({
        peer_pubkey: toBuffer(pubkey),
        direction: PeeringPaymentDirection.SELL,
      })
      .first()

    return row ? fromDBPeeringPayment(row) : undefined
  }

  public async ensureRow(pubkey: Pubkey, client: DatabaseClient): Promise<void> {
    await client<DBPeeringPayment>('peering_payments')
      .insert({
        peer_pubkey: toBuffer(pubkey),
        direction: PeeringPaymentDirection.SELL,
        status: PeeringPaymentStatus.UNPAID,
      })
      .onConflict(['peer_pubkey', 'direction'])
      .ignore()
  }

  public async lockByPeer(pubkey: Pubkey, client: DatabaseClient): Promise<PeeringPayment | undefined> {
    const row = await client<DBPeeringPayment>('peering_payments')
      .where({
        peer_pubkey: toBuffer(pubkey),
        direction: PeeringPaymentDirection.SELL,
      })
      .forUpdate()
      .first()

    return row ? fromDBPeeringPayment(row) : undefined
  }

  public async recordCheck(
    pubkey: Pubkey,
    checkedAt: Date,
    error: string | null,
    client: DatabaseClient = this.dbClient,
  ): Promise<void> {
    await client<DBPeeringPayment>('peering_payments')
      .update({
        last_checked_at: checkedAt,
        last_error: error,
        updated_at: new Date(),
      })
      .where({
        peer_pubkey: toBuffer(pubkey),
        direction: PeeringPaymentDirection.SELL,
      })
  }

  public async save(payment: PeeringPayment, client: DatabaseClient = this.dbClient): Promise<PeeringPayment> {
    const row = toRow(payment)
    const now = new Date()

    await client<DBPeeringPayment>('peering_payments')
      .update({
        ...row,
        updated_at: now,
      })
      .where({
        peer_pubkey: row.peer_pubkey,
        direction: row.direction,
      })

    return {
      ...payment,
      updatedAt: now,
    }
  }

  public async list(): Promise<PeeringPayment[]> {
    const rows = await this.dbClient<DBPeeringPayment>('peering_payments')
      .where('direction', PeeringPaymentDirection.SELL)
      .orderBy('peer_pubkey', 'asc')

    return rows.map(fromDBPeeringPayment)
  }

  public async findDueForRenewal(before: Date, limit: number, offset: number): Promise<PeeringPayment[]> {
    const rows = await this.dbClient<DBPeeringPayment>('peering_payments')
      .where('direction', PeeringPaymentDirection.SELL)
      .whereIn('status', [PeeringPaymentStatus.ACTIVE, PeeringPaymentStatus.RENEWAL_PENDING])
      .whereNotNull('period_end')
      .where('period_end', '<=', before)
      .orderBy('period_end', 'asc')
      .offset(offset)
      .limit(limit)

    return rows.map(fromDBPeeringPayment)
  }

  public async findPeriodEnded(now: Date, limit: number, offset: number): Promise<PeeringPayment[]> {
    const rows = await this.dbClient<DBPeeringPayment>('peering_payments')
      .where('direction', PeeringPaymentDirection.SELL)
      .whereIn('status', [PeeringPaymentStatus.ACTIVE, PeeringPaymentStatus.RENEWAL_PENDING])
      .whereNotNull('period_end')
      .where('period_end', '<=', now)
      .orderBy('period_end', 'asc')
      .offset(offset)
      .limit(limit)

    logger('found %d peering period end(s)', rows.length)

    return rows.map(fromDBPeeringPayment)
  }
}
