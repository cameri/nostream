export type AdminOpsConnectionState = 'connecting' | 'open' | 'closed'

export interface AdminOpsMirrorHeartbeat {
  index: string
  targetUrl: string
  connectionState: AdminOpsConnectionState
  reconnectCount: number
  lastError?: string
  lastEventAt?: string
  updatedAt: string
}

export interface AdminOpsWorkerHeartbeat {
  type: string
  index?: string
  lastRunStartedAt?: string
  lastRunFinishedAt?: string
  lastError?: string
  updatedAt: string
}

export interface AdminOpsConfiguredMirror {
  index: string
  targetUrl: string
  enabled: boolean
}

export interface AdminOpsConfiguredWorker {
  type: string
  index?: string
  enabled: boolean
  label: string
}

export interface AdminOpsMirrorRow extends AdminOpsConfiguredMirror {
  heartbeat?: AdminOpsMirrorHeartbeat
  stale: boolean
}

export interface AdminOpsWorkerRow extends AdminOpsConfiguredWorker {
  heartbeat?: AdminOpsWorkerHeartbeat
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
