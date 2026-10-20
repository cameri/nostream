import { RedisAdapter } from '../adapters/redis-adapter'
import { ICacheAdapter } from '../@types/adapters'
import { getCacheClient } from '../cache/client'

export const createAdminOpsCacheAdapter = (): ICacheAdapter | undefined => {
  try {
    return new RedisAdapter(getCacheClient())
  } catch {
    return undefined
  }
}
