import { randomBytes } from 'crypto'

import { DatabaseClient, Pubkey } from '../@types/base'
import { DBInviteCode, InviteCode } from '../@types/invite-code'
import { IInviteCodeRepository } from '../@types/repositories'
import { createLogger } from '../factories/logger-factory'
import { toBuffer } from '../utils/transform'

const logger = createLogger('invite-code-repository')

export function generateInviteCode(): string {
  return randomBytes(16).toString('hex')
}

function fromDBInviteCode(row: DBInviteCode): InviteCode {
  return {
    code: row.code,
    createdBy: row.created_by ? row.created_by.toString('hex') : null,
    claimedBy: row.claimed_by ? row.claimed_by.toString('hex') : null,
    expiresAt: row.expires_at,
    maxUses: row.max_uses,
    useCount: row.use_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function affectedRows(result: unknown): number {
  if (typeof result === 'number') { return result }
  if (result && typeof (result as any).rowCount === 'number') { return (result as any).rowCount }
  return 0
}

export class InviteCodeRepository implements IInviteCodeRepository {
  public constructor(private readonly dbClient: DatabaseClient) {}

  public async create(
    code: string,
    expiresAt?: Date,
    maxUses: number = 1,
    client: DatabaseClient = this.dbClient,
  ): Promise<InviteCode> {
    logger('create invite code: %s (expires: %s, maxUses: %d)', code, expiresAt ?? 'never', maxUses)

    const now = new Date()
    const row: DBInviteCode = {
      code,
      created_by: null,
      claimed_by: null,
      expires_at: expiresAt ?? null,
      max_uses: maxUses,
      use_count: 0,
      created_at: now,
      updated_at: now,
    }

    await client<DBInviteCode>('invite_codes').insert(row)

    return fromDBInviteCode(row)
  }

  public async findByCode(
    code: string,
    client: DatabaseClient = this.dbClient,
  ): Promise<InviteCode | undefined> {
    logger('find invite code: %s', code)

    const [row] = await client<DBInviteCode>('invite_codes')
      .where('code', code)
      .select()

    if (!row) {
      return
    }

    return fromDBInviteCode(row)
  }

  // Atomic claim: single UPDATE ensures only one caller wins on a single-use code
  public async claimCode(
    code: string,
    pubkey: Pubkey,
    client: DatabaseClient = this.dbClient,
  ): Promise<boolean> {
    logger('claim invite code %s for %s', code, pubkey)

    const now = new Date()

    const result = await client<DBInviteCode>('invite_codes')
      .where('code', code)
      .where(function () {
        this.where('max_uses', 0) // 0 = unlimited uses
          .orWhereRaw('use_count < max_uses')
      })
      .where(function () {
        this.whereNull('expires_at')
          .orWhere('expires_at', '>', now)
      })
      .update({
        use_count: client.raw('use_count + 1'),
        claimed_by: toBuffer(pubkey),
        updated_at: now,
      } as any)

    return affectedRows(result) > 0
  }

  public async findActiveCodes(
    limit: number = 100,
    client: DatabaseClient = this.dbClient,
  ): Promise<InviteCode[]> {
    logger('find active invite codes (limit %d)', limit)

    const now = new Date()

    const rows = await client<DBInviteCode>('invite_codes')
      .where(function () {
        this.whereNull('expires_at')
          .orWhere('expires_at', '>', now)
      })
      .where(function () {
        this.where('max_uses', 0)
          .orWhereRaw('use_count < max_uses')
      })
      .orderBy('created_at', 'desc')
      .limit(limit)
      .select()

    return rows.map(fromDBInviteCode)
  }

  public async deleteExpiredCodes(
    client: DatabaseClient = this.dbClient,
  ): Promise<number> {
    logger('delete expired invite codes')

    const now = new Date()

    const result = await client<DBInviteCode>('invite_codes')
      .whereNotNull('expires_at')
      .where('expires_at', '<=', now)
      .delete()

    const count = affectedRows(result)
    logger('deleted %d expired invite codes', count)

    return count
  }
}
