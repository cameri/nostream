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
    // Kick off the graph build as soon as the singleton exists (effectively
    // at worker boot, since this factory runs while wiring up the message
    // handler/event strategy chains) instead of waiting for the first
    // report or PoW check to pay for a cold-start rebuild.
    instance.warmUp()
  }

  return instance
}
