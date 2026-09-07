import { createLogger } from '../factories/logger-factory'
import { EventKinds, EventTags } from '../constants/base'
import { ICacheAdapter } from '../@types/adapters'
import { IEventRepository } from '../@types/repositories'
import { IWotGraphService } from '../@types/services'
import { Pubkey, Tag } from '../@types/base'
import { Settings } from '../@types/settings'
import { toNostrEvent } from '../utils/event'

const logger = createLogger('wot-graph-service')

const SEED_PUBKEY_PATTERN = /^[0-9a-f]{64}$/i

const followSetKey = (pubkey: Pubkey): string => `wot:follows:${pubkey}`

const extractFollowedPubkeys = (tags: Tag[]): Pubkey[] =>
  tags
    .filter((tag) => tag[0] === EventTags.Pubkey && typeof tag[1] === 'string' && tag[1].length > 0)
    .map((tag) => tag[1])

export class WotGraphService implements IWotGraphService {
  private distances: Map<Pubkey, number> = new Map()

  private ready = false

  private building: Promise<void> | undefined

  private rebuildQueued = false

  public constructor(
    private readonly cache: ICacheAdapter,
    private readonly eventRepository: IEventRepository,
    private readonly settings: () => Settings,
  ) {}

  public isReady(): boolean {
    return this.ready
  }

  public async getDistance(pubkey: Pubkey): Promise<number | undefined> {
    const wot = this.settings().wot
    if (!wot?.enabled || !wot.seedPubkey) {
      return undefined
    }

    if (pubkey === wot.seedPubkey) {
      return 0
    }

    await this.ensureBuilt()

    return this.distances.get(pubkey)
  }

  public async isTrusted(pubkey: Pubkey): Promise<boolean> {
    return typeof (await this.getDistance(pubkey)) === 'number'
  }

  public async updateFollowList(pubkey: Pubkey, follows: Pubkey[]): Promise<void> {
    const wot = this.settings().wot
    if (!wot?.enabled) {
      return
    }

    await this.cache.deleteKey(followSetKey(pubkey))
    if (follows.length) {
      await this.cache.addToSet(followSetKey(pubkey), follows)
    }

    // A pubkey outside the current trust graph publishing a new follow list
    // can't change anyone's distance from the seed, so only rebuild when the
    // change could actually matter. Fire-and-forget: the event path must not
    // block on a full graph rebuild, and scheduleRebuild() coalesces any
    // other triggers that land while one is already in flight.
    if (pubkey === wot.seedPubkey || this.distances.has(pubkey)) {
      void this.scheduleRebuild()
    }
  }

  private async ensureBuilt(): Promise<void> {
    if (this.ready) {
      return
    }
    await this.scheduleRebuild()
  }

  // Ensures at most one rebuild runs at a time. A trigger that lands while a
  // rebuild is already in flight doesn't start a second one -- it just marks
  // that another rebuild should run once the current one finishes, so a
  // burst of kind-3 events collapses into at most one extra rebuild rather
  // than one per event. Failures are caught here (not left to the caller) so
  // `this.building` always clears -- otherwise every future call would keep
  // awaiting the same rejected promise until a restart.
  private scheduleRebuild(): Promise<void> {
    if (this.building) {
      this.rebuildQueued = true
      return this.building
    }

    this.building = this.rebuild()
      .catch((error) => {
        logger.error('wot graph rebuild failed: %o', error)
      })
      .finally(() => {
        this.building = undefined
        if (this.rebuildQueued) {
          this.rebuildQueued = false
          void this.scheduleRebuild()
        }
      })

    return this.building
  }

  private async rebuild(): Promise<void> {
    const wot = this.settings().wot
    if (!wot?.enabled || !wot.seedPubkey) {
      this.distances = new Map()
      this.ready = true
      return
    }

    if (!SEED_PUBKEY_PATTERN.test(wot.seedPubkey)) {
      logger.error('wot.seedPubkey %o is not a 64-character hex pubkey; trust graph will be empty', wot.seedPubkey)
      this.distances = new Map()
      this.ready = true
      return
    }

    const maxDepth = wot.maxDepth ?? 2
    const minimumFollowers = wot.minimumFollowers ?? 1

    const distances = new Map<Pubkey, number>()
    // Persists across depth levels (not reset per level) so a candidate's
    // follower count reflects every already-trusted account that follows it,
    // not just the immediately preceding frontier -- matches minimumFollowers'
    // documented meaning at any maxDepth, not only maxDepth=2.
    const followerCounts = new Map<Pubkey, number>()
    let frontier = [wot.seedPubkey]

    for (let depth = 1; depth <= maxDepth && frontier.length; depth++) {
      const layerCandidates = new Set<Pubkey>()

      for (const pubkey of frontier) {
        const follows = await this.getFollows(pubkey)
        for (const followed of follows) {
          if (followed === wot.seedPubkey || distances.has(followed)) {
            continue
          }
          followerCounts.set(followed, (followerCounts.get(followed) ?? 0) + 1)
          layerCandidates.add(followed)
        }
      }

      // Direct follows of the seed are always trusted; deeper hops need at
      // least `minimumFollowers` already-trusted accounts pointing at them.
      const threshold = depth === 1 ? 1 : minimumFollowers
      const nextFrontier: Pubkey[] = []
      for (const candidate of layerCandidates) {
        if ((followerCounts.get(candidate) ?? 0) >= threshold) {
          distances.set(candidate, depth)
          nextFrontier.push(candidate)
        }
      }

      frontier = nextFrontier
    }

    this.distances = distances
    this.ready = true
    logger('rebuilt wot graph: %d pubkeys within %d hops of %s', distances.size, maxDepth, wot.seedPubkey)
  }

  private async getFollows(pubkey: Pubkey): Promise<Pubkey[]> {
    // Redis is the fast path once a pubkey's follow list has gone through
    // updateFollowList(); a pubkey that genuinely follows no one is
    // indistinguishable from an uncached one here and falls back to the DB
    // on every rebuild -- acceptable for a first pass, since that's the rare
    // case in a real follow graph.
    const cached = await this.cache.getSetMembers(followSetKey(pubkey))
    if (cached.length) {
      return cached
    }

    const [event] = await this.eventRepository.findByFilters([
      { kinds: [EventKinds.CONTACT_LIST], authors: [pubkey], limit: 1 },
    ])

    if (!event) {
      return []
    }

    const follows = extractFollowedPubkeys(toNostrEvent(event).tags)
    if (follows.length) {
      await this.cache.addToSet(followSetKey(pubkey), follows)
    }
    return follows
  }
}
