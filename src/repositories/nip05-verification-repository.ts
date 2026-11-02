import { applySpec, pipe, prop } from 'ramda'

import { DatabaseClient, Pubkey } from '../@types/base'
import { DBNip05Verification, Nip05Verification } from '../@types/nip05'
import { fromBuffer, toBuffer } from '../utils/transform'
import { createLogger } from '../factories/logger-factory'
import { INip05VerificationRepository, Nip05VerificationAdminListQuery } from '../@types/repositories'

const logger = createLogger('nip05-verification-repository')

const fromDBNip05Verification = applySpec<Nip05Verification>({
  pubkey: pipe(prop('pubkey') as () => Buffer, fromBuffer),
  nip05: prop('nip05') as () => string,
  domain: prop('domain') as () => string,
  isVerified: prop('is_verified') as () => boolean,
  lastVerifiedAt: prop('last_verified_at') as () => Date | null,
  lastCheckedAt: prop('last_checked_at') as () => Date,
  failureCount: prop('failure_count') as () => number,
  createdAt: prop('created_at') as () => Date,
  updatedAt: prop('updated_at') as () => Date,
})

export class Nip05VerificationRepository implements INip05VerificationRepository {
  public constructor(private readonly dbClient: DatabaseClient) {}

  public async findByPubkey(pubkey: Pubkey): Promise<Nip05Verification | undefined> {
    logger('find by pubkey: %s', pubkey)

    const [row] = await this.dbClient<DBNip05Verification>('nip05_verifications')
      .where('pubkey', toBuffer(pubkey))
      .select()

    if (!row) {
      return undefined
    }

    return fromDBNip05Verification(row)
  }

  public async upsert(verification: Nip05Verification): Promise<number> {
    logger('upsert: %s (%s)', verification.pubkey, verification.nip05)

    const now = new Date()

    const row: DBNip05Verification = {
      pubkey: toBuffer(verification.pubkey),
      nip05: verification.nip05,
      domain: verification.domain,
      is_verified: verification.isVerified,
      last_verified_at: verification.lastVerifiedAt,
      last_checked_at: verification.lastCheckedAt || now,
      failure_count: verification.failureCount,
      created_at: now,
      updated_at: now,
    }

    const query = this.dbClient<DBNip05Verification>('nip05_verifications').insert(row).onConflict('pubkey').merge({
      nip05: row.nip05,
      domain: row.domain,
      is_verified: row.is_verified,
      last_verified_at: row.last_verified_at,
      last_checked_at: row.last_checked_at,
      failure_count: row.failure_count,
      updated_at: now,
    })

    return {
      then: <T1, T2>(
        onfulfilled: (value: number) => T1 | PromiseLike<T1>,
        onrejected: (reason: any) => T2 | PromiseLike<T2>,
      ) => query.then(prop('rowCount') as () => number).then(onfulfilled, onrejected),
      catch: <T>(onrejected: (reason: any) => T | PromiseLike<T>) => query.catch(onrejected),
      toString: (): string => query.toString(),
    } as Promise<number>
  }

  public async findPendingVerifications(
    updateFrequencyMs: number,
    maxFailures: number,
    limit: number,
  ): Promise<Nip05Verification[]> {
    logger('find pending verifications (frequency: %dms, maxFailures: %d)', updateFrequencyMs, maxFailures)

    const cutoff = new Date(Date.now() - updateFrequencyMs)

    const rows = await this.dbClient<DBNip05Verification>('nip05_verifications')
      .where('last_checked_at', '<', cutoff)
      .andWhere('failure_count', '<', maxFailures)
      .orderBy('last_checked_at', 'asc')
      .limit(limit)

    return rows.map(fromDBNip05Verification)
  }

  public async deleteByPubkey(pubkey: Pubkey): Promise<number> {
    logger('delete by pubkey: %s', pubkey)

    return this.dbClient<DBNip05Verification>('nip05_verifications').where('pubkey', toBuffer(pubkey)).delete()
  }

  public async listForAdmin(query: Nip05VerificationAdminListQuery): Promise<{ rows: Nip05Verification[]; total: number }> {
    let builder = this.dbClient<DBNip05Verification>('nip05_verifications')

    if (query.domain) {
      builder = builder.where('domain', query.domain)
    }

    if (query.verified !== undefined) {
      builder = builder.where('is_verified', query.verified)
    }

    if (query.minFailures !== undefined) {
      builder = builder.where('failure_count', '>=', query.minFailures)
    }

    if (query.stale !== undefined) {
      const cutoff = new Date(Date.now() - query.verifyExpirationMs)
      if (query.stale) {
        builder = builder.where((clause) => {
          clause
            .where('is_verified', false)
            .orWhereNull('last_verified_at')
            .orWhere('last_verified_at', '<', cutoff)
        })
      } else {
        builder = builder.where('is_verified', true).andWhere('last_verified_at', '>=', cutoff)
      }
    }

    const countRow = await builder.clone().count<{ count: string }>({ count: '*' }).first()
    const total = Number(countRow?.count ?? 0)

    const rows = await builder
      .orderBy('last_checked_at', 'desc')
      .limit(query.limit)
      .offset(query.offset)

    return { rows: rows.map(fromDBNip05Verification), total }
  }
}
