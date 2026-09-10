import { ICacheAdapter } from '../@types/adapters'
import { IEventRepository } from '../@types/repositories'
import { IWotGraphService } from '../@types/services'
import { Settings } from '../@types/settings'
import { WotGraphService } from '../services/wot-graph-service'

let instance: IWotGraphService | undefined

export const wotGraphServiceFactory = (
  cache: ICacheAdapter,
  eventRepository: IEventRepository,
  settings: () => Settings,
): IWotGraphService => {
  if (!instance) {
    instance = new WotGraphService(cache, eventRepository, settings)
  }

  return instance
}
