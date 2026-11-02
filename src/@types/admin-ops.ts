export interface AdminOpsWorkerHeartbeat {
  type: string
  index?: string
  lastRunStartedAt?: string
  lastRunFinishedAt?: string
  lastError?: string
  updatedAt: string
}

export interface AdminOpsConfiguredWorker {
  type: string
  index?: string
  enabled: boolean
  label: string
}

export interface AdminOpsWorkerRow extends AdminOpsConfiguredWorker {
  heartbeat?: AdminOpsWorkerHeartbeat
  monitored: boolean
  stale: boolean
}

export interface AdminNip05VerificationAdminRow {
  pubkey: string
  nip05: string
  domain: string
  isVerified: boolean
  failureCount: number
  lastVerifiedAt: string | null
  lastCheckedAt: string
  stale: boolean
}

export interface AdminOpsStorageCountRow {
  kinds: number[]
  count: number
}
