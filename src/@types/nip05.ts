import { Pubkey } from './base'

export interface Nip05Verification {
  pubkey: Pubkey
  nip05: string
  domain: string
  isVerified: boolean
  lastVerifiedAt: Date | null
  lastCheckedAt: Date
  failureCount: number
  createdAt: Date
  updatedAt: Date
}

export interface DBNip05Verification {
  pubkey: Buffer
  nip05: string
  domain: string
  is_verified: boolean
  last_verified_at: Date | null
  last_checked_at: Date
  failure_count: number
  created_at: Date
  updated_at: Date
}
