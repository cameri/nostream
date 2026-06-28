export interface InviteCode {
  code: string
  createdBy: string | null
  claimedBy: string | null
  expiresAt: Date | null
  remainingUses: number | null
  createdAt: Date
  updatedAt: Date
}

export interface DBInviteCode {
  code: string
  created_by: Buffer | null
  claimed_by: Buffer | null
  expires_at: Date | null
  remaining_uses: number | null
  created_at: Date
  updated_at: Date
}
