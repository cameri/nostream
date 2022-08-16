import { PassThrough } from 'stream'
import { DBEvent, Event } from './event'
import { SubscriptionFilter } from './subscription'

export type ExposedPromiseKeys = 'then' | 'catch' | 'finally'

export interface IQueryResult<T> extends Pick<Promise<T>, keyof Promise<T> & ExposedPromiseKeys> {
  stream(options?: Record<string, any>): PassThrough & AsyncIterable<T>
}

export interface IEventRepository {
  create(event: Event): Promise<number>
  upsert(event: Event): Promise<number>
  findByFilters(filters: SubscriptionFilter[]): IQueryResult<DBEvent[]>
}
