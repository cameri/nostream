import { Pubkey } from './base'

export enum DvmJobStatus {
  SUBMITTED = 'submitted',
  PICKED_UP = 'picked_up',
  COMPLETED = 'completed',
  FAILED = 'failed',
  TIMED_OUT = 'timed_out',
}

export interface DvmJob {
  id: string
  requesterPubkey: Pubkey
  kind: number
  workerIndex: number | null
  status: DvmJobStatus
  resultEventId: string | null
  error: string | null
  pickedUpAt: Date | null
  completedAt: Date | null
  createdAt: Date
  updatedAt: Date
}

export interface DBDvmJob {
  id: Buffer
  requester_pubkey: Buffer
  kind: number
  worker_index: number | null
  status: DvmJobStatus
  result_event_id: Buffer | null
  error: string | null
  picked_up_at: Date | null
  completed_at: Date | null
  created_at: Date
  updated_at: Date
}
