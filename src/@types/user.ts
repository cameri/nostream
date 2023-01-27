import { Pubkey } from './base'

export interface User {
  pubkey: Pubkey
  isAdmitted: boolean
  balance: bigint
  tosAcceptedAt?: Date | null
  createdAt: Date
  updatedAt: Date
}

export interface DBUser {
  pubkey: Buffer
  is_admitted: boolean
  balance: bigint
  created_at: Date
  updated_at: Date
}
