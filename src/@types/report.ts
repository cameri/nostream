import { EventId, Pubkey } from './base'

// NIP-56 standard report types.
export enum ReportType {
  NUDITY = 'nudity',
  MALWARE = 'malware',
  PROFANITY = 'profanity',
  ILLEGAL = 'illegal',
  SPAM = 'spam',
  IMPERSONATION = 'impersonation',
  OTHER = 'other',
}

export interface Report {
  id: EventId
  reporterPubkey: Pubkey
  reportedPubkey: Pubkey | null
  reportedEventId: EventId | null
  reportType: ReportType
  weight: number
  actionable: boolean
  createdAt: Date
}

export interface DBReport {
  id: Buffer
  reporter_pubkey: Buffer
  reported_pubkey: Buffer | null
  reported_event_id: Buffer | null
  report_type: ReportType
  weight: number
  actionable: boolean
  created_at: Date
}
