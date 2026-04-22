import { PassThrough } from 'stream'

import { DatabaseClient, EventId, Pubkey } from './base'
import { DBEvent, Event } from './event'
import { EventKinds } from '../constants/base'
import { EventKindsRange } from './settings'
import { Invoice } from './invoice'
import { Nip05Verification } from './nip05'
import { SubscriptionFilter } from './subscription'
import { User } from './user'

export interface EventRetentionOptions {
  maxDays?: number
  kindWhitelist?: (EventKinds | EventKindsRange)[]
  pubkeyWhitelist?: Pubkey[]
}

export interface EventPurgeCounts {
  deleted: number
  expired: number
  retained: number
}

export type ExposedPromiseKeys = 'then' | 'catch' | 'finally'

export interface IQueryResult<T> extends Pick<Promise<T>, keyof Promise<T> & ExposedPromiseKeys> {
  stream(options?: Record<string, any>): PassThrough & AsyncIterable<T>
}

export interface IEventRepository {
  create(event: Event): Promise<number>
  createMany(events: Event[]): Promise<number>
  upsert(event: Event): Promise<number>
  upsertMany(events: Event[]): Promise<number>
  findByFilters(filters: SubscriptionFilter[]): IQueryResult<DBEvent[]>
  countByFilters(filters: SubscriptionFilter[]): Promise<number>
  deleteByPubkeyAndIds(pubkey: Pubkey, ids: EventId[]): Promise<number>
  deleteByPubkeyExceptKinds(pubkey: Pubkey, excludedKinds: number[]): Promise<number>
  hasActiveRequestToVanish(pubkey: Pubkey): Promise<boolean>
  deleteExpiredAndRetained(options?: EventRetentionOptions): Promise<EventPurgeCounts>
}

export interface IInvoiceRepository {
  findById(id: string, client?: DatabaseClient): Promise<Invoice | undefined>
  upsert(invoice: Partial<Invoice>, client?: DatabaseClient): Promise<number>
  updateStatus(invoice: Pick<Invoice, 'id' | 'status'>, client?: DatabaseClient): Promise<Invoice | undefined>
  confirmInvoice(invoiceId: string, amountReceived: bigint, confirmedAt: Date, client?: DatabaseClient): Promise<void>
  findPendingInvoices(offset?: number, limit?: number, client?: DatabaseClient): Promise<Invoice[]>
}

export interface IUserRepository {
  findByPubkey(pubkey: Pubkey, client?: DatabaseClient): Promise<User | undefined>
  upsert(user: Partial<User>, client?: DatabaseClient): Promise<number>
  getBalanceByPubkey(pubkey: Pubkey, client?: DatabaseClient): Promise<bigint>
  isVanished(pubkey: Pubkey, client?: DatabaseClient): Promise<boolean>
  setVanished(pubkey: Pubkey, vanished: boolean, client?: DatabaseClient): Promise<number>
  admitUser(pubkey: Pubkey, admittedAt: Date, client?: DatabaseClient): Promise<void>
}

export interface INip05VerificationRepository {
  findByPubkey(pubkey: Pubkey): Promise<Nip05Verification | undefined>
  upsert(verification: Nip05Verification): Promise<number>
  findPendingVerifications(updateFrequencyMs: number, maxFailures: number, limit: number): Promise<Nip05Verification[]>
  deleteByPubkey(pubkey: Pubkey): Promise<number>
}
