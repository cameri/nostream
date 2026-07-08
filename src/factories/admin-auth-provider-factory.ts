import { Nip98AdminAuthProvider } from '../admin/nip98-admin-auth-provider'
import { RedisNip98ReplayGuard } from '../admin/redis-nip98-replay-guard'
import { IAdminAuthProvider } from '../@types/admin'
import { getCacheClient } from '../cache/client'
import { createSettings } from './settings-factory'

export const createAdminAuthProvider = (): IAdminAuthProvider => {
  return new Nip98AdminAuthProvider(createSettings, new RedisNip98ReplayGuard(getCacheClient))
}
