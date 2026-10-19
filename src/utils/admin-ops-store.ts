import { ICacheAdapter } from '../@types/adapters'
import { AdminOpsMirrorHeartbeat, AdminOpsWorkerHeartbeat } from '../@types/admin-ops'
import { createLogger } from '../factories/logger-factory'
import { sanitizeAdminOpsError } from './admin-ops-sanitize'

const logger = createLogger('admin-ops-store')

export const ADMIN_OPS_HEARTBEAT_INDEX_KEY = 'admin:ops:heartbeat:index'
export const ADMIN_OPS_HEARTBEAT_TTL_SECONDS = 120
export const ADMIN_OPS_HEARTBEAT_KEEPALIVE_MS = 45_000

const mirrorKey = (index: string) => `admin:ops:mirror:${index}`
const workerKey = (type: string, index?: string) =>
  typeof index === 'string' && index.length > 0 ? `admin:ops:worker:${type}:${index}` : `admin:ops:worker:${type}`

const indexMember = (category: 'mirror' | 'worker', id: string) => `${category}:${id}`

export class AdminOpsStore {
  public constructor(private readonly cache: ICacheAdapter) {}

  public async publishMirror(state: AdminOpsMirrorHeartbeat): Promise<void> {
    const key = mirrorKey(state.index)
    const member = indexMember('mirror', state.index)
    await this.cache.setKey(key, JSON.stringify(state), ADMIN_OPS_HEARTBEAT_TTL_SECONDS)
    await this.cache.addToSet(ADMIN_OPS_HEARTBEAT_INDEX_KEY, [member])
    await this.cache.setKeyExpiry(ADMIN_OPS_HEARTBEAT_INDEX_KEY, ADMIN_OPS_HEARTBEAT_TTL_SECONDS * 4)
  }

  public async publishWorker(state: AdminOpsWorkerHeartbeat): Promise<void> {
    const key = workerKey(state.type, state.index)
    const member = indexMember('worker', typeof state.index === 'string' ? `${state.type}:${state.index}` : state.type)
    await this.cache.setKey(key, JSON.stringify(state), ADMIN_OPS_HEARTBEAT_TTL_SECONDS)
    await this.cache.addToSet(ADMIN_OPS_HEARTBEAT_INDEX_KEY, [member])
    await this.cache.setKeyExpiry(ADMIN_OPS_HEARTBEAT_INDEX_KEY, ADMIN_OPS_HEARTBEAT_TTL_SECONDS * 4)
  }

  public async listMirrorHeartbeats(): Promise<AdminOpsMirrorHeartbeat[]> {
    const members = await this.cache.getSetMembers(ADMIN_OPS_HEARTBEAT_INDEX_KEY)
    const mirrorMembers = members.filter((member) => member.startsWith('mirror:'))

    const heartbeats: AdminOpsMirrorHeartbeat[] = []
    for (const member of mirrorMembers) {
      const index = member.slice('mirror:'.length)
      const raw = await this.cache.getKey(mirrorKey(index))
      if (!raw) {
        continue
      }
      try {
        heartbeats.push(JSON.parse(raw) as AdminOpsMirrorHeartbeat)
      } catch {
        // ignore corrupt payloads
      }
    }

    return heartbeats.sort((a, b) => a.index.localeCompare(b.index, undefined, { numeric: true }))
  }

  public async listWorkerHeartbeats(): Promise<AdminOpsWorkerHeartbeat[]> {
    const members = await this.cache.getSetMembers(ADMIN_OPS_HEARTBEAT_INDEX_KEY)
    const workerMembers = members.filter((member) => member.startsWith('worker:'))

    const heartbeats: AdminOpsWorkerHeartbeat[] = []
    for (const member of workerMembers) {
      const id = member.slice('worker:'.length)
      const separator = id.indexOf(':')
      const type = separator >= 0 ? id.slice(0, separator) : id
      const index = separator >= 0 ? id.slice(separator + 1) : undefined
      const raw = await this.cache.getKey(workerKey(type, index))
      if (!raw) {
        continue
      }
      try {
        heartbeats.push(JSON.parse(raw) as AdminOpsWorkerHeartbeat)
      } catch {
        // ignore corrupt payloads
      }
    }

    return heartbeats.sort((a, b) => {
      const typeCompare = a.type.localeCompare(b.type)
      if (typeCompare !== 0) {
        return typeCompare
      }
      return (a.index ?? '').localeCompare(b.index ?? '', undefined, { numeric: true })
    })
  }
}

let sharedStore: AdminOpsStore | undefined

export const getAdminOpsStore = (cache: ICacheAdapter): AdminOpsStore => {
  if (!sharedStore) {
    sharedStore = new AdminOpsStore(cache)
  }
  return sharedStore
}

const sanitizeMirrorHeartbeat = (state: AdminOpsMirrorHeartbeat): AdminOpsMirrorHeartbeat => ({
  ...state,
  lastError: state.lastError !== undefined ? sanitizeAdminOpsError(state.lastError) : undefined,
})

const sanitizeWorkerHeartbeat = (state: AdminOpsWorkerHeartbeat): AdminOpsWorkerHeartbeat => ({
  ...state,
  lastError: state.lastError !== undefined ? sanitizeAdminOpsError(state.lastError) : undefined,
})

export const publishAdminOpsMirrorHeartbeat = async (
  cache: ICacheAdapter,
  state: AdminOpsMirrorHeartbeat,
): Promise<void> => {
  await getAdminOpsStore(cache).publishMirror(sanitizeMirrorHeartbeat(state))
}

export const publishAdminOpsWorkerHeartbeat = async (
  cache: ICacheAdapter,
  state: AdminOpsWorkerHeartbeat,
): Promise<void> => {
  await getAdminOpsStore(cache).publishWorker(sanitizeWorkerHeartbeat(state))
}

export const publishAdminOpsMirrorHeartbeatSafely = async (
  cache: ICacheAdapter | undefined,
  state: AdminOpsMirrorHeartbeat,
): Promise<void> => {
  if (!cache) {
    return
  }
  try {
    await publishAdminOpsMirrorHeartbeat(cache, state)
  } catch (error) {
    logger.warn('failed to publish mirror ops heartbeat: %o', error)
  }
}

export const publishAdminOpsWorkerHeartbeatSafely = async (
  cache: ICacheAdapter | undefined,
  state: AdminOpsWorkerHeartbeat,
): Promise<void> => {
  if (!cache) {
    return
  }
  try {
    await publishAdminOpsWorkerHeartbeat(cache, state)
  } catch (error) {
    logger.warn('failed to publish worker ops heartbeat: %o', error)
  }
}

export const isAdminOpsHeartbeatStale = (updatedAtIso: string | undefined, ttlSeconds: number): boolean => {
  if (!updatedAtIso) {
    return true
  }
  const updatedAt = Date.parse(updatedAtIso)
  if (!Number.isFinite(updatedAt)) {
    return true
  }
  return Date.now() - updatedAt > ttlSeconds * 1000
}
