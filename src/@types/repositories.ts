import { PassThrough } from 'stream'
import { Pubkey } from './base'
import { DBEvent, Event, EventId } from './event'
import { SubscriptionFilter } from './subscription'

export type ExposedPromiseKeys = 'then' | 'catch' | 'finally'

export interface IQueryResult<T> extends Pick<Promise<T>, keyof Promise<T> & ExposedPromiseKeys> {
  stream(options?: Record<string, any>): PassThrough & AsyncIterable<T>
}

export interface IEventRepository {
  create(event: Event): Promise<number>
  upsert(event: Event): Promise<number>
  findByFilters(filters: SubscriptionFilter[]): IQueryResult<DBEvent[]>
  deleteByPubkeyAndIds(pubkey: Pubkey, ids: EventId[]): Promise<number>
}
