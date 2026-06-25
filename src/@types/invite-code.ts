export interface InviteCode {
  code: string
  createdBy: string | null
  claimedBy: string | null
  expiresAt: Date | null
  maxUses: number
  useCount: number
  createdAt: Date
  updatedAt: Date
}

export interface DBInviteCode {
  code: string
  created_by: Buffer | null
  claimed_by: Buffer | null
  expires_at: Date | null
  max_uses: number
  use_count: number
  created_at: Date
  updated_at: Date
}
