import { Event } from './event'
import { SubscriptionFilter } from './subscription'

export interface IEventRepository {
  create(event: Event): Promise<void>
  findByfilters(filters: SubscriptionFilter[]): Promise<Event[]>
}
