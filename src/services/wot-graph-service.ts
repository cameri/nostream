import { createLogger } from '../factories/logger-factory'
import { EventKinds, EventTags } from '../constants/base'
import { ICacheAdapter } from '../@types/adapters'
import { IEventRepository } from '../@types/repositories'
import { IWotGraphService } from '../@types/services'
import { Pubkey, Tag } from '../@types/base'
import { Settings } from '../@types/settings'
import { toNostrEvent } from '../utils/event'

const logger = createLogger('wot-graph-service')

const followSetKey = (pubkey: Pubkey): string => `wot:follows:${pubkey}`

const extractFollowedPubkeys = (tags: Tag[]): Pubkey[] =>
  tags
    .filter((tag) => tag[0] === EventTags.Pubkey && typeof tag[1] === 'string' && tag[1].length > 0)
    .map((tag) => tag[1])

export class WotGraphService implements IWotGraphService {
  private distances: Map<Pubkey, number> = new Map()

  private ready = false

  private building: Promise<void> | undefined

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
    // change could actually matter.
    if (pubkey === wot.seedPubkey || this.distances.has(pubkey)) {
      await this.rebuild()
    }
  }

  private async ensureBuilt(): Promise<void> {
    if (this.ready) {
      return
    }
    if (!this.building) {
      this.building = this.rebuild()
    }
    await this.building
  }

  private async rebuild(): Promise<void> {
    const wot = this.settings().wot
    if (!wot?.enabled || !wot.seedPubkey) {
      this.distances = new Map()
      this.ready = true
      this.building = undefined
      return
    }

    const maxDepth = wot.maxDepth ?? 2
    const minimumFollowers = wot.minimumFollowers ?? 1

    const distances = new Map<Pubkey, number>()
    let frontier = [wot.seedPubkey]

    for (let depth = 1; depth <= maxDepth && frontier.length; depth++) {
      const followerCounts = new Map<Pubkey, number>()

      for (const pubkey of frontier) {
        const follows = await this.getFollows(pubkey)
        for (const followed of follows) {
          if (followed === wot.seedPubkey || distances.has(followed)) {
            continue
          }
          followerCounts.set(followed, (followerCounts.get(followed) ?? 0) + 1)
        }
      }

      // Direct follows of the seed are always trusted; deeper hops need at
      // least `minimumFollowers` already-trusted accounts pointing at them.
      const threshold = depth === 1 ? 1 : minimumFollowers
      const nextFrontier: Pubkey[] = []
      for (const [candidate, count] of followerCounts) {
        if (count >= threshold) {
          distances.set(candidate, depth)
          nextFrontier.push(candidate)
        }
      }

      frontier = nextFrontier
    }

    this.distances = distances
    this.ready = true
    this.building = undefined
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
